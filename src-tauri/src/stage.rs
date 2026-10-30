//! 把选中的行写进 index —— Desktop 交互模型的后端。
//!
//! Desktop 的暂存语义：文件复选框和 diff 行选择是同一份状态的两个视图。
//! 全选 = 整个文件进提交，部分选 = 只有选中的行进提交。
//! 这里负责把「选中的行」落成 index 里的一个 blob。

use std::path::Path;

/// 一个文件在这次提交里怎么处理。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageFile {
    pub path: String,
    /// 重命名的旧路径。它在 index 里是单独一条，得一起处理
    pub old_path: Option<String>,
    pub include: Include,
    /// `include = partial` 时，前端用 patch-formatter 生成好的补丁
    pub patch: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Include {
    /// 整份进这次提交
    All,
    /// 不进这次提交
    None,
    /// 只进选中的那几行
    Partial,
}

/// 把整份勾选状态一次性落到 index。
///
/// 以前是「一个文件一次 IPC，每次重写一遍整个 index」。5 万文件的仓库里改
/// 2000 个文件，光暂存就要一分多钟（实测头 500 个 17.6 秒）——切个分支、跑个
/// 代码生成就能撞上。原版（stageFiles）是按类别批量走 update-index，
/// 这里照它来：同一类的路径攒成一批，一次 git 调用解决。
///
/// 顺序照原版：
///   1. 整个 index 退回 HEAD（新仓库退回空 index）
///   2. 重命名的**旧路径**强制从 index 里拿掉 —— 不然「foo 改名成 bar，同时又
///      新建了一个 foo」这种情况下，旧 foo 会被当成新文件带进提交
///   3. 勾上的整份 `git update-index`（新增/修改/删除/重命名的新路径/冲突解决 它都认）
///   4. 部分勾选的逐个打补丁 —— 这类本来就少（得手动去点行）
pub fn apply_selection(root: &Path, files: &[StageFile]) -> Result<(), String> {
    // Hold Git's normal index lock for the whole transaction. Other Git writers
    // must fail rather than have their changes overwritten by our final rename.
    let index = crate::git::Git::new(Some(root))
        .args(["rev-parse", "--path-format=absolute", "--git-path", "index"])
        .stdout()?;
    let index = std::path::PathBuf::from(index.trim_end_matches('\n'));
    let mut lock_path = index.as_os_str().to_os_string();
    lock_path.push(".lock");
    let lock_path = std::path::PathBuf::from(lock_path);
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|e| format!("锁定 index 失败: {e}"))?;
    let _lock = IndexLock { path: lock_path, _file: lock };
    let directory = tempfile::tempdir_in(index.parent().ok_or("index 路径缺少父目录")?)
        .map_err(|e| format!("创建临时 index 失败: {e}"))?;
    let temporary = directory.path().join("index");
    match std::fs::copy(&index, &temporary) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("复制 index 失败: {e}")),
    }
    apply_selection_to_index(root, files, &temporary)?;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&temporary)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("同步 index 失败: {e}"))?;
    std::fs::rename(&temporary, &index).map_err(|e| format!("提交 index 失败: {e}"))?;
    Ok(())
}

struct IndexLock {
    path: std::path::PathBuf,
    _file: std::fs::File,
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn apply_selection_to_index(root: &Path, files: &[StageFile], index: &Path) -> Result<(), String> {
    let git = || crate::git::Git::new(Some(root)).env("GIT_INDEX_FILE", index);
    let nul_list = |v: &[String]| {
        let mut s = v.join("\0");
        s.push('\0');
        s
    };

    // 必须在 reset 前记住“从 index 删除但磁盘仍有文件”的状态，避免重新加入私密文件。
    let deleted: std::collections::HashSet<_> = crate::status::status(root)?
        .changes
        .into_iter()
        .filter(|file| file.change == crate::status::ChangeType::Deleted)
        .map(|file| file.path)
        .collect();
    let mut include: Vec<String> = Vec::new();
    let mut old_renamed: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();

    for f in files {
        if f.include == Include::Partial && f.patch.is_none() {
            return Err(format!("部分暂存缺少补丁: {}", f.path));
        }
        match f.include {
            Include::None => {}
            Include::All => {
                include.push(f.path.clone());
                if deleted.contains(&f.path) {
                    removed.push(f.path.clone());
                }
                if let Some(o) = &f.old_path {
                    old_renamed.push(o.clone());
                }
            }
            Include::Partial => {}
        }
    }

    // Desktop createCommit 的 unstageAll：不让未选择、未列出的旧暂存内容混进提交。
    git().args(["reset", "-q", "--", "."]).run()?;
    if !old_renamed.is_empty() {
        git().args(["update-index", "--force-remove", "-z", "--stdin"]).stdin(nul_list(&old_renamed)).run()?;
    }
    if !include.is_empty() {
        git()
            .args(["update-index", "--add", "--remove", "--replace", "-z", "--stdin"])
            .stdin(nul_list(&include))
            .run()?;
    }
    if !removed.is_empty() {
        git()
            .args(["update-index", "--add", "--remove", "--force-remove", "--replace", "-z", "--stdin"])
            .stdin(nul_list(&removed))
            .run()?;
    }
    for f in files {
        if f.include == Include::Partial
            && let Some(patch) = &f.patch
        {
            if let Some(old) = &f.old_path {
                // Desktop applyPatchToIndex：重建 rename，再把选中的行应用到新名字。
                git().args(["add", "--update", "--", old]).run()?;
                let tree = git().args(["ls-tree", "HEAD", "--", old]).stdout()?;
                let info = tree.split('\t').next().unwrap_or_default();
                let mut fields = info.split_whitespace();
                let mode = fields.next().ok_or("重命名源文件缺少 mode")?;
                let _kind = fields.next();
                let oid = fields.next().ok_or("重命名源文件缺少 oid")?;
                git().args(["update-index", "--add", "--cacheinfo", mode, oid, &f.path]).run()?;
            } else {
                git().args(["reset", "--", &f.path]).run()?;
            }
            git().args(["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "-"]).stdin(patch).run()?;
        }
    }
    Ok(())
}

/// 读出「已暂存版本」和「工作区版本」，两者的差异就是待选内容。
fn versions(repo: &gix::Repository, root: &Path, rel: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    let index = repo.open_index().map_err(|e| format!("读 index 失败: {e}"))?;
    let staged = match index.entry_index_by_path(rel.into()) {
        Ok(pos) => {
            let entry = &index.entries()[pos];
            // 只有普通文件才是 blob。submodule（COMMIT，0o160000）指向 commit，
            // 稀疏目录条目（DIR）指向 tree —— 照 blob 读会把对象的原始字节
            // 当文本渲染出来（界面上就是一屏乱码）。
            use gix::index::entry::Mode;
            let m = entry.mode;
            if m == Mode::FILE || m == Mode::FILE_EXECUTABLE || m == Mode::SYMLINK {
                repo.find_object(entry.id).map_err(|e| format!("读已暂存 blob 失败: {e}"))?.data.clone()
            } else {
                Vec::new()
            }
        }
        // 不在 index 里 = 未跟踪的新文件，基准是空内容
        Err(_) => Vec::new(),
    };
    let worktree = std::fs::read(root.join(rel)).unwrap_or_default();
    Ok((staged, worktree))
}

/// 两侧原始文本：index 里已暂存的版本，和工作区当前的版本。
///
/// Monaco 的 DiffEditor 要的是两份完整文本，自己算 diff 并负责渲染、
/// 折行、语法高亮和词级高亮——这些都不该我们手写。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub original: String,
    pub modified: String,
    /// 给 Monaco 判断语言用
    pub path: String,
}

pub fn file_contents(root: &Path, rel: &str) -> Result<FileContents, String> {
    let repo = gix::open(root).map_err(|e| format!("打开仓库失败: {e}"))?;
    let (staged, worktree) = versions(&repo, root, rel)?;
    Ok(FileContents {
        original: String::from_utf8_lossy(&staged).into_owned(),
        modified: String::from_utf8_lossy(&worktree).into_owned(),
        path: rel.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// 测试里故意直接调 git，不走 crate::git 的封装——
    /// 判定标准应当是 git 自己怎么看，而不是我们的封装怎么说。
    fn git(repo: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(repo).args(args).output().unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        std::fs::write(r.join("f.txt"), "A1\nA2\nA3\n---\nB1\nB2\nB3\n").unwrap();
        git(&r, &["add", "f.txt"]);
        git(&r, &["commit", "-qm", "init"]);
        std::fs::write(r.join("f.txt"), "A1\nA2x\nA3\n---\nB1\nB2x\nB3\n").unwrap();
        (dir, r)
    }

    /// 冲突文件在编辑器里改干净之后，勾上它应当等于「这一版就是结果」。
    /// `--name-only` 默认会把非 ASCII 路径转义（core.quotepath），
    /// 断言里要的是原样，所以走 -z。
    fn staged_names(r: &Path) -> Vec<String> {
        git(r, &["diff", "--cached", "--name-only", "-z"])
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn plan(path: &str, include: Include) -> StageFile {
        StageFile { path: path.into(), old_path: None, include, patch: None }
    }

    #[test]
    fn split_index_is_supported() {
        let (_d, r) = fixture();
        git(&r, &["update-index", "--split-index"]);
        apply_selection(&r, &[plan("f.txt", Include::All)]).unwrap();
        assert_eq!(git(&r, &["show", ":f.txt"]), std::fs::read_to_string(r.join("f.txt")).unwrap());
    }

    #[test]
    fn empty_selection_in_unborn_repository_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        apply_selection(dir.path(), &[]).unwrap();
        assert_eq!(git(dir.path(), &["ls-files"]), "");
    }

    #[test]
    fn failed_partial_stage_preserves_original_index_and_worktree() {
        let (_d, r) = fixture();
        git(&r, &["add", "f.txt"]);
        std::fs::write(r.join("new.txt"), "new content\n").unwrap();
        let before = std::fs::read(r.join(".git/index")).unwrap();
        let worktree = std::fs::read(r.join("f.txt")).unwrap();
        let result = apply_selection(
            &r,
            &[
                plan("new.txt", Include::All),
                StageFile {
                    path: "f.txt".into(),
                    old_path: None,
                    include: Include::Partial,
                    patch: Some("invalid patch\n".into()),
                },
            ],
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(r.join(".git/index")).unwrap(), before);
        assert_eq!(std::fs::read(r.join("f.txt")).unwrap(), worktree);
        assert_eq!(staged_names(&r), vec!["f.txt"]);
        assert!(!r.join(".git/index.lock").exists());
        apply_selection(&r, &[plan("new.txt", Include::All)]).unwrap();
        assert_eq!(staged_names(&r), vec!["new.txt"]);
    }

    #[test]
    fn existing_index_lock_is_not_removed_or_overwritten() {
        let (_d, r) = fixture();
        let before = std::fs::read(r.join(".git/index")).unwrap();
        std::fs::write(r.join(".git/index.lock"), "another writer").unwrap();
        assert!(apply_selection(&r, &[plan("f.txt", Include::All)]).is_err());
        assert_eq!(std::fs::read(r.join(".git/index")).unwrap(), before);
        assert_eq!(std::fs::read_to_string(r.join(".git/index.lock")).unwrap(), "another writer");
    }

    #[test]
    fn unborn_repository_stages_without_an_existing_index() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        git(r, &["init", "-q", "-b", "main"]);
        std::fs::write(r.join("new.txt"), "new\n").unwrap();
        apply_selection(r, &[plan("new.txt", Include::All)]).unwrap();
        assert_eq!(git(r, &["show", ":new.txt"]), "new\n");
    }

    #[test]
    fn linked_worktree_updates_only_its_own_index() {
        let (_d, r) = fixture();
        let other = tempfile::tempdir().unwrap();
        git(&r, &["worktree", "add", "-b", "other", other.path().to_str().unwrap()]);
        let before = std::fs::read(r.join(".git/index")).unwrap();
        std::fs::write(other.path().join("f.txt"), "linked worktree\n").unwrap();
        apply_selection(other.path(), &[plan("f.txt", Include::All)]).unwrap();
        assert_eq!(git(other.path(), &["show", ":f.txt"]), "linked worktree\n");
        assert_eq!(std::fs::read(r.join(".git/index")).unwrap(), before);
    }

    #[test]
    fn 批量落盘_勾的进没勾的不进() {
        let (_d, r) = fixture();
        std::fs::write(r.join("新的.txt"), "新\n").unwrap();
        std::fs::write(r.join("另一个.txt"), "另\n").unwrap();

        apply_selection(
            &r,
            &[plan("f.txt", Include::All), plan("新的.txt", Include::All), plan("另一个.txt", Include::None)],
        )
        .unwrap();

        let staged = staged_names(&r);
        assert!(staged.iter().any(|p| p == "f.txt"), "勾了的该进去: {staged:?}");
        assert!(staged.iter().any(|p| p == "新的.txt"), "新文件也该进去: {staged:?}");
        assert!(!staged.iter().any(|p| p == "另一个.txt"), "没勾的不该进去: {staged:?}");
    }

    #[test]
    fn 批量落盘_删除和重命名() {
        let (_d, r) = fixture();
        git(&r, &["checkout", "-q", "--", "f.txt"]);
        std::fs::write(r.join("长文件.txt"), "内容够长才认得出是重命名\n".repeat(10)).unwrap();
        std::fs::write(r.join("要删的.txt"), "删我\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "准备"]);

        std::fs::rename(r.join("长文件.txt"), r.join("新名字.txt")).unwrap();
        std::fs::remove_file(r.join("要删的.txt")).unwrap();

        apply_selection(
            &r,
            &[
                StageFile {
                    path: "新名字.txt".into(),
                    old_path: Some("长文件.txt".into()),
                    include: Include::All,
                    patch: None,
                },
                plan("要删的.txt", Include::All),
            ],
        )
        .unwrap();

        let st = git(&r, &["-c", "core.quotepath=false", "status", "--short"]);
        assert!(st.contains("R  长文件.txt -> 新名字.txt"), "重命名该被记下: {st:?}");
        assert!(st.contains("D  要删的.txt"), "删除该被暂存: {st:?}");
        assert!(!st.contains("??"), "不该留下未跟踪的东西: {st:?}");
    }

    /// 改名之后又在原位置新建了一个同名文件：只勾「改名」时，
    /// 新建的那个不能被顺手带进提交（原版 stageFiles 的注释专门讲了这个）
    #[test]
    fn 改名后原位置又有新文件时不会误带() {
        let (_d, r) = fixture();
        git(&r, &["checkout", "-q", "--", "f.txt"]);
        std::fs::write(r.join("foo.txt"), "内容够长才认得出是重命名\n".repeat(10)).unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "有了 foo"]);

        std::fs::rename(r.join("foo.txt"), r.join("bar.txt")).unwrap();
        std::fs::write(r.join("foo.txt"), "我是新来的 foo\n").unwrap();

        apply_selection(
            &r,
            &[StageFile {
                path: "bar.txt".into(),
                old_path: Some("foo.txt".into()),
                include: Include::All,
                patch: None,
            }],
        )
        .unwrap();

        let staged = staged_names(&r);
        let st = git(&r, &["status", "--short"]);
        assert!(staged.iter().any(|p| p == "bar.txt"), "改名该进去: {staged:?}");
        assert!(st.contains("?? foo.txt"), "新建的 foo 该还是未跟踪: {st:?}");
    }

    #[test]
    fn 勾上冲突文件等于把它标成已解决() {
        let (_d, r) = fixture();
        git(&r, &["checkout", "-q", "--", "f.txt"]);
        git(&r, &["switch", "-qc", "他们"]);
        std::fs::write(r.join("f.txt"), "他们改的\n").unwrap();
        git(&r, &["commit", "-qam", "他们"]);
        git(&r, &["switch", "-q", "-"]);
        std::fs::write(r.join("f.txt"), "我们改的\n").unwrap();
        git(&r, &["commit", "-qam", "我们"]);
        git(&r, &["merge", "他们"]);
        assert!(!git(&r, &["ls-files", "-u"]).trim().is_empty(), "该是冲突状态");

        // 用户在编辑器里手工合好了
        std::fs::write(r.join("f.txt"), "两边合起来\n").unwrap();
        apply_selection(&r, &[plan("f.txt", Include::All)]).unwrap();

        assert!(git(&r, &["ls-files", "-u"]).trim().is_empty(), "冲突应已解除");
        assert!(git(&r, &["diff", "--cached", "--name-only"]).contains("f.txt"), "解决后的内容应进了暂存区");
    }

    #[test]
    fn 取消勾选会把已暂存的内容退回_head() {
        let (_d, r) = fixture();
        // 先整份暂存，模拟「文件早就在 index 里」
        git(&r, &["add", "f.txt"]);
        assert!(!git(&r, &["diff", "--cached", "--name-only"]).trim().is_empty());

        // 取消勾选
        apply_selection(&r, &[plan("f.txt", Include::None)]).unwrap();
        assert_eq!(
            git(&r, &["diff", "--cached", "--name-only"]).trim(),
            "",
            "取消勾选后 index 应该和 HEAD 一致，否则这文件还是会被提交进去"
        );
        // 工作区的改动不能被动到
        assert!(git(&r, &["diff", "--name-only"]).contains("f.txt"), "不该丢掉工作区改动");
    }

    #[test]
    fn 取消勾选重命名不会把文件删掉() {
        let (_d, r) = fixture();
        git(&r, &["checkout", "-q", "--", "f.txt"]);
        git(&r, &["mv", "f.txt", "g.txt"]);
        // `git mv` 在 index 里留下两条：旧路径删除 + 新路径新增
        assert!(git(&r, &["status", "--short"]).contains("R  f.txt -> g.txt"));

        apply_selection(
            &r,
            &[StageFile { path: "g.txt".into(), old_path: Some("f.txt".into()), include: Include::None, patch: None }],
        )
        .unwrap();
        assert_eq!(
            git(&r, &["diff", "--cached", "--name-only"]).trim(),
            "",
            "只退回新路径的话，这次提交会变成「把 f.txt 删了」"
        );
        // 工作区里文件仍然叫新名字——取消勾选只动 index，不动磁盘
        assert!(r.join("g.txt").exists());
        assert!(!r.join("f.txt").exists());
    }
}
