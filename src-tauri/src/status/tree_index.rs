//! HEAD 树与索引的比较（「已暂存」那一侧），按索引的 cache-tree 扩展跳过没变的子树。
//!
//! gix 的 `tree_index_status` 先把整个 HEAD 树展开成一份索引（解码所有树对象），再与 `.git/index` 逐条比较。
//! git 的 `diff-index --cached` 不这么做：索引的 TREE 扩展记着每个目录对应的树对象 id，某个目录的记录
//! 有效（条目数不是 -1）且 id 与 HEAD 里同一目录的树相同，这个目录下的条目就和 HEAD 一致，整棵子树跳过
//! （unpack-trees.c 的 cache-tree 快速路径）。git 改动索引条目时会把它路径上的各级目录作废，所以一个有效的
//! 记录代表这个目录在索引里的内容。这里照同样的规则只展开不能跳过的目录，再按路径归并出新增 / 删除 / 修改。
//!
//! 冲突条目（stage 1–3）与 intent-to-add 条目照 gix `diff::index` 的规则处理：这类条目不报任何改动，
//! 与 HEAD 里同一路径的条目对上时一起跳过（只消耗一次，后面的 stage 当作没有对应）。含这类条目的目录不按
//! 记录跳过（git 改动这类条目时本来就会把路径上的记录作废，这里不依赖这一点），其余子树照常按 cache-tree 跳过。
//!
//! 归并结果和 gix 一致的前提（不满足就整个交给 gix，结果不变）：
//! - 不是稀疏索引；
//! - 不需要改名 / 复制检测：同时有新增和删除时，或者配置了复制检测且有新增时，交给 gix 的改名跟踪；
//! - 能跳过的目录还要求记录的条目数与索引里该目录下的条目数相同。

use gix::bstr::{BStr, BString, ByteSlice};
use gix::index::entry::{Flags, Mode};
use std::cmp::Ordering;
use std::ops::Range;

/// 暂存区一侧的一条改动。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Change {
    Added(String),
    Deleted(String),
    Modified(String),
    Rewritten { path: String, source: String, copy: bool },
}

/// 用了哪条路径：测试与基准据此确认快速路径确实生效。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Outcome {
    /// 根目录的记录有效且与 HEAD 相同，没有展开任何树
    pub(crate) root_matched: bool,
    /// 按记录跳过的目录数
    pub(crate) skipped_trees: usize,
    /// 交给了 gix（`Some` 时是原因）
    pub(crate) fallback: Option<&'static str>,
}

pub(crate) fn changes(repo: &gix::Repository, index: &gix::index::State) -> Result<(Vec<Change>, Outcome), String> {
    let head = repo.head_tree_id_or_empty().map_err(|e| format!("读取 HEAD 树失败: {e}"))?.detach();
    match fast(repo, index, head)? {
        Ok(result) => Ok(result),
        Err(reason) => Ok((via_gix(repo, index, head)?, Outcome { fallback: Some(reason), ..Outcome::default() })),
    }
}

/// gix 自己的比较（展开整个 HEAD 树，按配置做改名跟踪）。
pub(crate) fn via_gix(
    repo: &gix::Repository, index: &gix::index::State, head: gix::ObjectId,
) -> Result<Vec<Change>, String> {
    use gix::diff::index::ChangeRef;
    let mut out = Vec::new();
    repo.tree_index_status(&head, index, None, Default::default(), |change, _, _| {
        out.push(match change {
            ChangeRef::Addition { location, .. } => Change::Added(location.to_string()),
            ChangeRef::Deletion { location, .. } => Change::Deleted(location.to_string()),
            ChangeRef::Modification { location, .. } => Change::Modified(location.to_string()),
            ChangeRef::Rewrite { source_location, location, copy, .. } => {
                Change::Rewritten { path: location.to_string(), source: source_location.to_string(), copy }
            }
        });
        Ok(std::ops::ControlFlow::Continue(()))
    })
    .map_err(|e| format!("比较 HEAD 与索引失败: {e}"))?;
    Ok(out)
}

/// 外层 `Err` 是读对象失败；内层 `Err` 是要交给 gix 的原因。
#[allow(clippy::type_complexity)]
fn fast(
    repo: &gix::Repository, index: &gix::index::State, head: gix::ObjectId,
) -> Result<Result<(Vec<Change>, Outcome), &'static str>, String> {
    if index.is_sparse() {
        return Ok(Err("sparse index"));
    }
    let entries = index.entries();
    // 冲突与 intent-to-add 条目：`special[i]` 是前 i 个条目里这类条目的个数（没有时不建）
    let special = entries.iter().any(ignored).then(|| {
        let mut counts = Vec::with_capacity(entries.len() + 1);
        let mut count = 0u32;
        counts.push(0);
        for entry in entries {
            count += u32::from(ignored(entry));
            counts.push(count);
        }
        counts
    });
    let cache = index.tree();
    if let Some(root) = cache
        && special.is_none()
        && root.num_entries.is_some_and(|n| n as usize == entries.len())
        && root.id == head
    {
        return Ok(Ok((Vec::new(), Outcome { root_matched: true, ..Outcome::default() })));
    }
    let mut walk =
        Flatten { repo, index, special: special.as_deref(), tree: Vec::new(), skipped: Vec::new(), buf: Vec::new() };
    let mut prefix = BString::default();
    if !head.is_empty_tree() {
        walk.tree_entries(head, &mut prefix, cache)?;
    }
    let Flatten { mut tree, mut skipped, .. } = walk;
    tree.sort_by(|a, b| a.0.cmp(&b.0));
    skipped.sort_by_key(|r| r.start);
    let skipped_trees = skipped.len();

    let mut changes = Vec::new();
    let (mut additions, mut deletions) = (false, false);
    let mut lhs = tree.iter().peekable();
    let mut ranges = skipped.iter().peekable();
    let mut i = 0;
    let mut next_rhs = || -> Option<(&BStr, &gix::index::Entry)> {
        // 跳过按 cache-tree 认定与 HEAD 相同的区间（区间按起点排好、互不重叠）
        while let Some(range) = ranges.peek() {
            if i >= range.end {
                ranges.next();
            } else if i >= range.start {
                i = range.end;
                ranges.next();
            } else {
                break;
            }
        }
        let entry = entries.get(i)?;
        i += 1;
        Some((entry.path(index), entry))
    };
    let mut rhs = next_rhs();
    loop {
        let ordering = match (lhs.peek(), rhs) {
            (None, None) => break,
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (Some((lpath, ..)), Some((rpath, _))) => lpath.as_bstr().cmp(rpath),
        };
        match ordering {
            Ordering::Less => {
                let (path, ..) = lhs.next().expect("peeked");
                deletions = true;
                changes.push(Change::Deleted(path.to_string()));
            }
            Ordering::Greater => {
                let (path, entry) = rhs.expect("present");
                rhs = next_rhs();
                if ignored(entry) {
                    continue;
                }
                additions = true;
                changes.push(Change::Added(path.to_string()));
            }
            Ordering::Equal => {
                let (path, mode, id) = lhs.next().expect("peeked");
                let (_, entry) = rhs.expect("present");
                if !ignored(entry) && (entry.id != *id || entry.mode != *mode) {
                    changes.push(Change::Modified(path.to_string()));
                }
                rhs = next_rhs();
            }
        }
    }
    if additions && deletions {
        return Ok(Err("additions and deletions need rename tracking"));
    }
    if additions && copies_configured(repo) {
        return Ok(Err("copy detection is configured"));
    }
    Ok(Ok((changes, Outcome { skipped_trees, ..Outcome::default() })))
}

/// gix `diff::index` 不报改动的条目：冲突的各个 stage 与 intent-to-add。
fn ignored(entry: &gix::index::Entry) -> bool {
    entry.stage_raw() != 0 || entry.flags.contains(Flags::INTENT_TO_ADD)
}

/// `status.renames` / `diff.renames` 设成了 copy / copies（gix 据此做复制检测）。
fn copies_configured(repo: &gix::Repository) -> bool {
    let config = repo.config_snapshot();
    ["status.renames", "diff.renames"].iter().any(|key| {
        config
            .string(*key)
            .is_some_and(|value| value.eq_ignore_ascii_case(b"copies") || value.eq_ignore_ascii_case(b"copy"))
    })
}

struct Flatten<'a> {
    repo: &'a gix::Repository,
    index: &'a gix::index::State,
    /// 见 `fast` 里的 `special`：区间里有冲突或 intent-to-add 条目的目录不跳过
    special: Option<&'a [u32]>,
    /// 展开出来的 HEAD 条目：(路径, 按 gix `State::from_tree` 换算的 mode, id)
    tree: Vec<(BString, Mode, gix::ObjectId)>,
    /// 按 cache-tree 跳过的索引条目区间
    skipped: Vec<Range<usize>>,
    buf: Vec<u8>,
}

impl Flatten<'_> {
    fn tree_entries(
        &mut self, id: gix::ObjectId, prefix: &mut BString, cache: Option<&gix::index::extension::Tree>,
    ) -> Result<(), String> {
        use gix::object::tree::EntryKind;
        use gix::prelude::FindExt;
        let mut buf = std::mem::take(&mut self.buf);
        let tree = self.repo.objects.find_tree(&id, &mut buf).map_err(|e| format!("读取树 {id} 失败: {e}"))?;
        // 先拷出条目：递归时要复用缓冲区
        let entries: Vec<(BString, gix::object::tree::EntryMode, gix::ObjectId)> =
            tree.entries.iter().map(|e| (BString::from(e.filename), e.mode, e.oid.to_owned())).collect();
        self.buf = buf;
        for (name, mode, oid) in entries {
            let start = prefix.len();
            if start > 0 {
                prefix.push(b'/');
            }
            prefix.extend_from_slice(&name);
            let kind = mode.kind();
            if kind == EntryKind::Tree {
                let child = cache.and_then(|c| c.children.iter().find(|t| t.name.as_slice() == name.as_bytes()));
                let skip = child.and_then(|child| {
                    let expected = child.num_entries? as usize;
                    if child.id != oid {
                        return None;
                    }
                    prefix.push(b'/');
                    let range = self.index.prefixed_entries_range(prefix.as_bstr());
                    prefix.pop();
                    range.filter(|r| {
                        r.len() == expected
                            && expected > 0
                            && self.special.is_none_or(|special| special[r.start] == special[r.end])
                    })
                });
                if let Some(range) = skip {
                    self.skipped.push(range);
                } else {
                    self.tree_entries(oid, prefix, child)?;
                }
            } else {
                let mode = match kind {
                    EntryKind::Blob => Mode::FILE,
                    EntryKind::BlobExecutable => Mode::FILE_EXECUTABLE,
                    EntryKind::Link => Mode::SYMLINK,
                    EntryKind::Commit => Mode::COMMIT,
                    EntryKind::Tree => unreachable!("handled above"),
                };
                self.tree.push((prefix.clone(), mode, oid));
            }
            prefix.truncate(start);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn write(root: &Path, path: &str, content: &str) {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn init() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main", "."]);
        git(&root, &["config", "user.email", "t@t.t"]);
        git(&root, &["config", "user.name", "t"]);
        (dir, root)
    }

    /// git 的暂存区一侧：`diff --cached --name-status`，改名与复制按 status 的配置。
    fn via_git(root: &Path) -> Vec<Change> {
        let out = git(root, &["--no-optional-locks", "status", "--porcelain=2", "-z", "--untracked-files=no"]);
        let mut changes = Vec::new();
        let mut records = out.split('\0');
        while let Some(record) = records.next() {
            let fields: Vec<&str> = record.splitn(10, ' ').collect();
            match fields.first() {
                Some(&"1") => {
                    let path = record.splitn(9, ' ').nth(8).unwrap().to_string();
                    match fields[1].as_bytes()[0] {
                        b'A' => changes.push(Change::Added(path)),
                        b'D' => changes.push(Change::Deleted(path)),
                        b'M' | b'T' => changes.push(Change::Modified(path)),
                        _ => {}
                    }
                }
                Some(&"2") => {
                    let source = records.next().unwrap().to_string();
                    let path = fields[9].to_string();
                    match fields[1].as_bytes()[0] {
                        b'R' => changes.push(Change::Rewritten { path, source, copy: false }),
                        b'C' => changes.push(Change::Rewritten { path, source, copy: true }),
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        changes.sort();
        changes
    }

    /// 快速路径与 gix 的完整比较相同（改名检测不在快速路径里，结果里有改名时一定是交给了 gix），
    /// 没有改名时也与 git 相同；返回快速路径的情况。
    fn check(root: &Path, step: &str) -> Outcome {
        let repo = crate::status::open_with_excludes(root).unwrap();
        let index = repo.index_or_empty().unwrap();
        let head = repo.head_tree_id_or_empty().unwrap().detach();
        let (mut fast, outcome) = changes(&repo, &index).unwrap();
        let mut full = via_gix(&repo, &index, head).unwrap();
        fast.sort();
        full.sort();
        assert_eq!(fast, full, "{step}: cache-tree 快速路径与 gix 不同（{outcome:?}）");
        if !fast.iter().any(|c| matches!(c, Change::Rewritten { .. })) {
            assert_eq!(fast, via_git(root), "{step}: 与 git 不同（{outcome:?}）");
        }
        outcome
    }

    fn base(root: &Path) {
        for dir in ["a", "a/x", "a/x/deep", "b", "b/y", "c"] {
            for i in 0..3 {
                write(root, &format!("{dir}/f{i}.txt"), &format!("{dir} {i}\n"));
            }
        }
        write(root, "top.txt", "top\n");
        git(root, &["add", "-A"]);
        git(root, &["commit", "-qm", "base"]);
    }

    #[test]
    fn cache_tree_干净时不展开任何树() {
        let (_d, root) = init();
        base(&root);
        let outcome = check(&root, "提交后");
        assert!(outcome.root_matched, "{outcome:?}");
        // 只改工作区不动索引：cache-tree 仍然有效
        write(&root, "a/x/f1.txt", "worktree only\n");
        assert!(check(&root, "只改工作区").root_matched);
    }

    #[test]
    fn cache_tree_暂存修改只展开路径上的目录() {
        let (_d, root) = init();
        base(&root);
        write(&root, "a/x/deep/f0.txt", "staged\n");
        git(&root, &["add", "a/x/deep/f0.txt"]);
        let outcome = check(&root, "深处的修改");
        assert!(!outcome.root_matched && outcome.fallback.is_none(), "{outcome:?}");
        // 根目录下 b、c 两个目录和 a 下没动的子目录都应跳过
        assert!(outcome.skipped_trees >= 2, "{outcome:?}");
        write(&root, "b/new.txt", "new\n");
        git(&root, &["add", "b/new.txt"]);
        check(&root, "再加一个新文件");
        git(&root, &["rm", "-q", "--cached", "c/f2.txt"]);
        let outcome = check(&root, "新增与删除同时存在");
        assert!(outcome.fallback.is_some(), "要做改名检测时交给 gix：{outcome:?}");
    }

    #[cfg(unix)] // 用到 unix 的文件权限与符号链接
    #[test]
    fn cache_tree_与_head_不同的有效记录要展开() {
        let (_d, root) = init();
        base(&root);
        write(&root, "b/y/f1.txt", "second\n");
        write(&root, "a/x/f0.txt", "second\n");
        git(&root, &["commit", "-qam", "second"]);
        // reset --soft 不动索引：cache-tree 还记着第二个提交的树，HEAD 却回到了第一个
        git(&root, &["reset", "-q", "--soft", "HEAD~1"]);
        let outcome = check(&root, "reset --soft");
        assert!(!outcome.root_matched, "{outcome:?}");
        let repo = crate::status::open_with_excludes(&root).unwrap();
        let index = repo.index_or_empty().unwrap();
        assert!(index.tree().is_some_and(|t| t.num_entries.is_some()), "索引里应有有效的 cache-tree");
        // 子模块、类型变化、可执行位
        git(&root, &["reset", "-q", "--hard"]);
        git(&root, &["update-index", "--chmod=+x", "c/f0.txt"]);
        std::fs::remove_file(root.join("c/f1.txt")).unwrap();
        std::os::unix::fs::symlink("f0.txt", root.join("c/f1.txt")).unwrap();
        git(&root, &["add", "c/f1.txt"]);
        check(&root, "可执行位与类型变化");
    }

    #[test]
    fn cache_tree_没有扩展与各种回退() {
        let (_d, root) = init();
        base(&root);
        // read-tree 写出的索引没有 cache-tree
        git(&root, &["read-tree", "HEAD"]);
        write(&root, "a/f0.txt", "changed\n");
        git(&root, &["update-index", "a/f0.txt"]);
        check(&root, "部分 cache-tree");
        std::fs::remove_file(root.join(".git/index")).unwrap();
        git(&root, &["read-tree", "--no-sparse-checkout", "HEAD"]);
        check(&root, "read-tree 之后");
        // intent-to-add：不报改动，其余目录照常跳过
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-qm", "refresh"]);
        write(&root, "b/ita.txt", "x\n");
        git(&root, &["add", "-N", "b/ita.txt"]);
        let outcome = check(&root, "intent-to-add");
        assert!(outcome.fallback.is_none() && outcome.skipped_trees >= 2, "{outcome:?}");
        write(&root, "c/f0.txt", "staged next to ita\n");
        git(&root, &["add", "c/f0.txt"]);
        check(&root, "intent-to-add 加上一处修改");
        git(&root, &["rm", "-q", "--cached", "b/ita.txt"]);
        // 复制检测
        write(&root, "copy.txt", "a 0\n");
        git(&root, &["add", "copy.txt"]);
        git(&root, &["config", "status.renames", "copies"]);
        assert_eq!(check(&root, "复制检测").fallback, Some("copy detection is configured"));
        // 空仓库（HEAD 未诞生）
        let (_d2, empty) = init();
        write(&empty, "first.txt", "1\n");
        git(&empty, &["add", "first.txt"]);
        check(&empty, "未诞生的 HEAD");
    }

    fn merge(root: &Path, args: &[&str]) {
        let _ = Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
    }

    fn has_conflicts(root: &Path) -> bool {
        !git(root, &["ls-files", "-u"]).is_empty()
    }

    #[test]
    fn cache_tree_冲突时只展开冲突所在的目录() {
        let (_d, root) = init();
        base(&root);
        git(&root, &["switch", "-qc", "side"]);
        write(&root, "a/x/deep/f0.txt", "side\n");
        write(&root, "b/f1.txt", "side clean change\n");
        git(&root, &["commit", "-qam", "side"]);
        git(&root, &["switch", "-q", "main"]);
        write(&root, "a/x/deep/f0.txt", "main\n");
        git(&root, &["commit", "-qam", "main"]);
        merge(&root, &["merge", "-q", "side"]);
        assert!(has_conflicts(&root));
        let outcome = check(&root, "冲突");
        assert!(outcome.fallback.is_none(), "冲突不再整体交给 gix：{outcome:?}");
        // c、a/x 下以外的目录都应按记录跳过（b 有合并进来的改动，不跳过）
        assert!(outcome.skipped_trees >= 2, "{outcome:?}");
        // 冲突之外只有删除：不必改名检测，冲突条目也不算新增
        git(&root, &["rm", "-q", "--cached", "c/f2.txt"]);
        assert_eq!(check(&root, "冲突加上删除").fallback, None);
        git(&root, &["add", "c/f2.txt"]);
        // 冲突之外再暂存修改、新增
        write(&root, "c/f1.txt", "staged during merge\n");
        write(&root, "c/new.txt", "new during merge\n");
        git(&root, &["add", "c/f1.txt", "c/new.txt"]);
        assert!(check(&root, "冲突加上暂存").fallback.is_none());
        // 新增加删除：仍交给 gix 做改名检测
        git(&root, &["rm", "-q", "--cached", "a/f2.txt"]);
        assert_eq!(check(&root, "冲突加上新增与删除").fallback, Some("additions and deletions need rename tracking"));
        // 解决冲突后
        git(&root, &["add", "a/x/deep/f0.txt"]);
        check(&root, "解决冲突");
    }

    /// 各种冲突形状：两边都改、两边都加、一边删一边改、改名对删除、文件对目录，冲突在根目录和深处，
    /// 合并带进来的干净改动在别的目录；每种都与 gix 的完整比较和 git 的暂存一列对照。
    #[test]
    fn cache_tree_各种冲突形状与_gix_和_git_一致() {
        type Side = fn(&Path);
        let shapes: [(&str, Side, Side); 7] = [
            ("两边都改", |r| write(r, "a/x/f0.txt", "ours\n"), |r| write(r, "a/x/f0.txt", "theirs\n")),
            ("两边都加", |r| write(r, "b/y/added.txt", "ours\n"), |r| write(r, "b/y/added.txt", "theirs\n")),
            (
                "我们删、他们改",
                |r| std::fs::remove_file(r.join("c/f0.txt")).unwrap(),
                |r| write(r, "c/f0.txt", "theirs\n"),
            ),
            ("我们改、他们删", |r| write(r, "top.txt", "ours\n"), |r| std::fs::remove_file(r.join("top.txt")).unwrap()),
            (
                "两边改成不同的名字",
                |r| std::fs::rename(r.join("a/f1.txt"), r.join("a/ours.txt")).unwrap(),
                |r| std::fs::rename(r.join("a/f1.txt"), r.join("b/theirs.txt")).unwrap(),
            ),
            ("文件对目录", |r| write(r, "b/clash", "file\n"), |r| write(r, "b/clash/inner.txt", "dir\n")),
            (
                "深处冲突加别处的干净改动",
                |r| write(r, "a/x/deep/f2.txt", "ours\n"),
                |r| {
                    write(r, "a/x/deep/f2.txt", "theirs\n");
                    write(r, "c/f2.txt", "clean theirs\n");
                    write(r, "d/new.txt", "theirs adds\n");
                },
            ),
        ];
        // (没交给 gix 的步数, 按记录跳过的目录数)
        let (mut fast_steps, mut skipped) = (0, 0);
        let mut tally = |outcome: Outcome| {
            fast_steps += usize::from(outcome.fallback.is_none());
            skipped += outcome.skipped_trees;
        };
        for (name, ours, theirs) in shapes {
            let (_d, root) = init();
            base(&root);
            git(&root, &["switch", "-qc", "side"]);
            theirs(&root);
            git(&root, &["add", "-A"]);
            git(&root, &["commit", "-qm", "theirs"]);
            git(&root, &["switch", "-q", "main"]);
            ours(&root);
            git(&root, &["add", "-A"]);
            git(&root, &["commit", "-qm", "ours"]);
            for strategy in [&["merge", "-q", "--no-edit", "side"][..], &["cherry-pick", "side"][..]] {
                merge(&root, &["reset", "-q", "--hard"]);
                merge(&root, &["merge", "--abort"]);
                merge(&root, &["cherry-pick", "--abort"]);
                merge(&root, strategy);
                assert!(has_conflicts(&root), "{name} / {strategy:?}: 应有冲突");
                tally(check(&root, &format!("{name} / {strategy:?}")));
                // 再暂存一处无关修改（没有删除，不必改名检测）
                write(&root, "b/f0.txt", "staged\n");
                git(&root, &["add", "b/f0.txt"]);
                tally(check(&root, &format!("{name} / {strategy:?} 加暂存")));
                // write-tree 写不出（有冲突），read-tree 后整份 cache-tree 作废
                merge(&root, &["update-index", "--really-refresh"]);
                tally(check(&root, &format!("{name} / {strategy:?} 刷新后")));
            }
        }
        eprintln!("冲突形状：{fast_steps} 步没交给 gix，共跳过 {skipped} 个目录");
        assert!(fast_steps >= 30 && skipped >= 30, "快速路径应在多数冲突步骤里生效：{fast_steps} 步，跳过 {skipped}");
    }

    /// git 写不出覆盖冲突条目的有效记录；别的工具写出来时，这样的目录也不能按记录跳过（否则 HEAD 里
    /// 那一侧的路径会被当成删除或漏掉）。在内存里给一份干净索引加上各个 stage 的条目，不动扩展。
    #[test]
    fn cache_tree_有效记录覆盖冲突条目时不跳过() {
        let (_d, root) = init();
        base(&root);
        let repo = crate::status::open_with_excludes(&root).unwrap();
        let head = repo.head_tree_id_or_empty().unwrap().detach();
        let index = repo.index_or_empty().unwrap();
        assert!(index.tree().is_some_and(|t| t.num_entries.is_some()), "提交后应有有效的 cache-tree");
        let id = index.entries()[0].id;
        let stage = |n: u32| Flags::from_bits_retain(n << 12);
        // (说明, 去掉的路径, 加上冲突条目的路径, 各个 stage)
        let cases: [(&str, &str, &str, &[u32]); 7] = [
            ("b 下改成 1/2/3", "b/f1.txt", "b/f1.txt", &[1, 2, 3]),
            ("b/y 下改成 2/3", "b/y/f0.txt", "b/y/f0.txt", &[2, 3]),
            ("根目录改成 1/2", "top.txt", "top.txt", &[1, 2]),
            ("a/x/deep 下只剩 3", "a/x/deep/f2.txt", "a/x/deep/f2.txt", &[3]),
            ("c 下 1/3 而路径换成新文件", "c/zz.txt", "c/zz.txt", &[1, 3]),
            // 条目数不变、删掉的是别的路径：跳过就漏报这个删除（冲突条目排在目录最后）
            ("b 下删掉 f0、新路径只有 stage 2", "b/f0.txt", "b/zz.txt", &[2]),
            ("c 下删掉 f2、新路径 stage 3 排在中间", "c/f2.txt", "c/f1a.txt", &[3]),
        ];
        for (name, removed, path, stages) in cases {
            let mut state = gix::index::State::clone(&index);
            state.remove_entries(|_, entry_path, _| entry_path == removed);
            for &n in stages {
                state.dangerously_push_entry(Default::default(), id, stage(n), Mode::FILE, BStr::new(path));
            }
            state.sort_entries();
            // 扩展仍标着有效，条目数改成与冲突后的索引相同（id 仍是 HEAD 的树）：只有「区间里有冲突条目
            // 不跳过」能挡住
            let entries = state.clone();
            if let Some(tree) = state.tree_mut() {
                fn fix(tree: &mut gix::index::extension::Tree, state: &gix::index::State, prefix: &str) {
                    let range = if prefix.is_empty() {
                        Some(0..state.entries().len())
                    } else {
                        state.prefixed_entries_range(BStr::new(&format!("{prefix}/")))
                    };
                    tree.num_entries = range.map(|r| r.len() as u32);
                    for child in &mut tree.children {
                        let name = String::from_utf8_lossy(&child.name).into_owned();
                        let child_prefix = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
                        fix(child, state, &child_prefix);
                    }
                }
                fix(tree, &entries, "");
            }
            let (mut fast, outcome) = changes(&repo, &state).unwrap();
            let mut full = via_gix(&repo, &state, head).unwrap();
            fast.sort();
            full.sort();
            assert_eq!(fast, full, "{name}: {outcome:?}");
            assert!(!outcome.root_matched, "{name}: {outcome:?}");
        }
    }

    #[test]
    fn cache_tree_随机暂存序列与_gix_和_git_一致() {
        let mut state = 0x853c_49e6_748f_ea9b_u64;
        let mut next = |n: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % n as u64) as usize
        };
        let (_d, root) = init();
        base(&root);
        const DIRS: [&str; 7] = ["a", "a/x", "a/x/deep", "b", "b/y", "c", "d/e"];
        let run = |args: &[&str]| {
            let _ = Command::new("git").arg("-C").arg(&root).args(args).output();
        };
        let mut skipped = 0;
        let mut conflicted_steps = 0;
        for step in 0..150 {
            let file = format!("{}/f{}.txt", DIRS[next(DIRS.len())], next(5));
            let description = match next(12) {
                10 | 11 => {
                    // 把一个路径换成冲突的几个 stage（路径在 HEAD 里可能有也可能没有），git 会作废路径上的记录
                    let blob = |content: &str| {
                        let mut child = Command::new("git")
                            .arg("-C")
                            .arg(&root)
                            .args(["hash-object", "-w", "--stdin"])
                            .stdin(std::process::Stdio::piped())
                            .stdout(std::process::Stdio::piped())
                            .spawn()
                            .unwrap();
                        use std::io::Write;
                        child.stdin.take().unwrap().write_all(content.as_bytes()).unwrap();
                        String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap().trim().to_string()
                    };
                    let stages: Vec<u32> = (1..=3).filter(|_| next(3) != 0).collect();
                    let stages = if stages.is_empty() { vec![2, 3] } else { stages };
                    let mut info = format!("0 {} 0\t{file}\n", "0".repeat(40));
                    for n in &stages {
                        info.push_str(&format!("100644 {} {n}\t{file}\n", blob(&format!("stage {n} of {step}\n"))));
                    }
                    let mut child = Command::new("git")
                        .arg("-C")
                        .arg(&root)
                        .args(["update-index", "--index-info"])
                        .stdin(std::process::Stdio::piped())
                        .spawn()
                        .unwrap();
                    use std::io::Write;
                    child.stdin.take().unwrap().write_all(info.as_bytes()).unwrap();
                    assert!(child.wait().unwrap().success());
                    conflicted_steps += 1;
                    format!("{file} 换成 stage {stages:?}")
                }
                0 | 1 => {
                    write(&root, &file, &format!("v{step}\n"));
                    run(&["add", "--", &file]);
                    format!("改写并暂存 {file}")
                }
                2 => {
                    run(&["rm", "-q", "--cached", "--ignore-unmatch", "--", &file]);
                    format!("rm --cached {file}")
                }
                3 => {
                    run(&["commit", "-qm", "step"]);
                    "commit".into()
                }
                4 => {
                    run(&["reset", "-q", "--soft", "HEAD~1"]);
                    "reset --soft HEAD~1".into()
                }
                5 => {
                    run(&["reset", "-q"]);
                    "reset（重写索引）".into()
                }
                6 => {
                    run(&["update-index", "--chmod=+x", "--", &file]);
                    format!("chmod +x {file}")
                }
                7 => {
                    let renamed = format!("{file}.moved");
                    run(&["mv", "--", &file, &renamed]);
                    format!("mv {file}")
                }
                8 => {
                    run(&["write-tree"]);
                    "write-tree（补全 cache-tree）".into()
                }
                _ => {
                    run(&["add", "-A"]);
                    "add -A".into()
                }
            };
            skipped += check(&root, &format!("第 {step} 步：{description}")).skipped_trees;
        }
        assert!(skipped > 50, "快速路径应在多数步骤里跳过子树：{skipped}");
        assert!(conflicted_steps > 10, "随机序列里应有冲突：{conflicted_steps}");
    }

    /// TREE 扩展过期却仍标着有效（别的工具改了索引条目而没作废它）：记录的条目数与索引对不上时不能跳过。
    /// git 写不出这样的索引，这里在内存里往提交后的索引加一个条目、不动扩展。
    #[test]
    fn cache_tree_记录与索引条目数对不上时不跳过() {
        let (_d, root) = init();
        base(&root);
        let repo = crate::status::open_with_excludes(&root).unwrap();
        let head = repo.head_tree_id_or_empty().unwrap().detach();
        let index = repo.index_or_empty().unwrap();
        assert!(index.tree().is_some_and(|t| t.num_entries.is_some()), "提交后应有有效的 cache-tree");
        let id = index.entries()[0].id;
        for path in ["b/zz.txt", "zz.txt"] {
            let mut state = gix::index::State::clone(&index);
            state.dangerously_push_entry(Default::default(), id, Flags::empty(), Mode::FILE, BStr::new(path));
            state.sort_entries();
            let (mut fast, outcome) = changes(&repo, &state).unwrap();
            let mut full = via_gix(&repo, &state, head).unwrap();
            fast.sort();
            full.sort();
            assert_eq!(fast, full, "{path}: {outcome:?}");
            assert_eq!(fast, vec![Change::Added(path.to_string())], "{path}: {outcome:?}");
        }
    }
}
