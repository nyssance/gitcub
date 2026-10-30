//! 提交历史 —— History 标签页的数据来源。
//!
//! 三块：提交列表、某次提交改了哪些文件、该文件在那次提交里的 diff。
//! 全部在进程内由 gix 完成，不用起 git 进程。

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub summary: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    /// Unix 秒。时区和格式化交给前端，按用户的 locale 显示。
    pub time: i64,
    /// 父提交个数。>1 就是合并提交——回滚它必须带 `-m 1` 指定沿哪条父线走。
    pub tags: Vec<String>,
    pub parent_count: u32,
    #[serde(rename = "parentSHAs")]
    pub parent_sh_as: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommitFileKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub kind: CommitFileKind,
    pub old_path: Option<String>,
    pub rename_includes_modifications: bool,
    pub submodule: bool,
    /// `--numstat` 的增删行数；二进制文件（git 输出 `-`）是 `None`，Desktop 把它按 0 计入总数
    pub lines_added: Option<u64>,
    pub lines_deleted: Option<u64>,
}

/// Resolve before composing ranges so ref names cannot become command options.
pub fn resolve_revision(root: &Path, revision: &str) -> Result<String, String> {
    crate::git::Git::new(Some(root))
        .args(["rev-parse", "--verify", "--end-of-options", revision])
        .stdout()
        .map(|sha| sha.trim().to_string())
}

/// 引用装饰索引按仓库缓存。翻页时引用表是最大开销（Desktop 仓库 688 个标签要 4 ms，
/// 翻页本身不到 1 ms），而引用只在 `refs/`、`packed-refs` 或 `HEAD` 变化时才变。
///
/// 索引覆盖 `git log` 默认装饰的全部命名空间（HEAD、refs/heads、refs/tags、
/// refs/remotes、refs/stash），标签索引只是它的一个视图。
struct RefIndex {
    fingerprint: Vec<Stamp>,
    /// 取指纹时修改时间还在 `RACY_WINDOW` 之内的文件：同一时间粒度里原地改写、长度不变时
    /// stat 看不出差别，所以指纹相同也照样重读它们（与 git 索引的 racy 判定同理）。
    racy: Vec<std::path::PathBuf>,
    /// 解析过的引用表。提交、fetch 之后通常只有几个松散引用文件变了，按指纹差异只重读这些。
    refs: RefTable,
    decorations: std::sync::Arc<Decorations>,
}

/// 路径、修改时间、大小、inode、是否目录。git 用「写临时文件再改名」更新引用，
/// 即便同一秒内改写、长度不变，inode 也会换。
type Stamp = (std::path::PathBuf, std::time::SystemTime, u64, u64, bool);

/// 修改时间离取指纹不到这么久的文件视为 racy（FAT 的时间粒度是 2 秒）。
const RACY_WINDOW: std::time::Duration = std::time::Duration::from_secs(3);

/// 引用名 → 解析结果，按名字字节序（git 引用遍历的顺序）。
type RefTable = std::collections::BTreeMap<Vec<u8>, RefEntry>;

#[derive(Debug, Clone, PartialEq)]
struct RefEntry {
    /// 符号引用：目标变了结果跟着变，而它自己的文件不变，所以增量更新时总是重新解析。
    symbolic: bool,
    /// `refs/replace/*`
    replace: bool,
    /// 剥到底的对象与装饰类型；悬空或过深的符号引用为 `None`（git 的遍历跳过它们）。
    resolved: Option<(gix::ObjectId, DecorationKind)>,
}

static REF_INDEX: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, RefIndex>>> =
    std::sync::LazyLock::new(Default::default);

/// git 给提交打装饰时区分的引用类型（log-tree.c `decoration_type`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DecorationKind {
    Head,
    Local,
    Tag,
    Remote,
    Stash,
    Plain,
}

#[derive(Debug, Clone)]
struct Decoration {
    kind: DecorationKind,
    /// 完整引用名；显示时才按 `prettify_refname` 去前缀。
    name: Vec<u8>,
}

#[derive(Debug)]
enum HeadState {
    Unborn,
    Detached(gix::ObjectId),
    Symbolic {
        branch: Vec<u8>,
        id: gix::ObjectId,
    },
    /// 多级符号引用等 git 和 gix 语义可能不同的情况：快速路径让位给 git。
    Unsupported,
}

/// 一次扫描全部引用得到的结果。
struct Decorations {
    /// 每个提交上的装饰，顺序与 git 的链表一致：HEAD 在前，其余按引用名降序。
    by_commit: std::collections::HashMap<gix::ObjectId, Vec<Decoration>>,
    head: HeadState,
    /// 存在 `refs/replace/*` 时 git 会替换对象，快速路径不处理。
    has_replace: bool,
    tags_by_commit: std::sync::Arc<std::collections::HashMap<String, Vec<String>>>,
    /// 本地分支、远端跟踪分支、标签按完整引用名排序剥到的对象，最后是 HEAD：`git log --all`
    /// 的起点顺序（refs 先按名字，`refs_head_ref` 最后），不含 `refs/stash`。
    tip_order: Vec<gix::ObjectId>,
    /// `tip_order` 去重、去掉非提交对象之后的提交图遍历起点。只有提交图用到，第一次用时才算
    /// （要查对象类型），随引用索引一起失效。
    graph_tips: std::sync::OnceLock<std::sync::Arc<Vec<gix::ObjectId>>>,
}

#[cfg(unix)]
fn inode(metadata: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.ino()
}

#[cfg(not(unix))]
fn inode(_: &std::fs::Metadata) -> u64 {
    0
}

/// `packed-refs`、`HEAD` 和 `refs` 树里每个文件、目录的修改时间、大小与 inode。
/// 新建、删除、改写引用、切换分支和 pack-refs 都会动到其中之一。
fn ref_fingerprint(repo: &gix::Repository) -> Vec<Stamp> {
    fn record(path: &Path, out: &mut Vec<Stamp>) {
        let Ok(metadata) = std::fs::metadata(path) else { return };
        out.push((
            path.to_path_buf(),
            metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            metadata.len(),
            inode(&metadata),
            metadata.is_dir(),
        ));
        if metadata.is_dir()
            && let Ok(entries) = std::fs::read_dir(path)
        {
            let mut children: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
            children.sort();
            for child in children {
                record(&child, out);
            }
        }
    }
    let common_dir = repo.common_dir();
    let git_dir = repo.git_dir();
    let mut out = Vec::new();
    record(&common_dir.join("packed-refs"), &mut out);
    record(&common_dir.join("refs"), &mut out);
    record(&git_dir.join("HEAD"), &mut out);
    if git_dir != common_dir {
        record(&git_dir.join("refs"), &mut out);
    }
    out
}

/// git 默认的装饰过滤（builtin/log.c `set_default_decoration_filter`）只放行
/// 带装饰类型的命名空间；`refs/notes`、`refs/pull` 这类一律不显示。
fn decoration_kind(name: &[u8]) -> Option<DecorationKind> {
    if name.starts_with(b"refs/heads/") {
        Some(DecorationKind::Local)
    } else if name.starts_with(b"refs/tags/") {
        Some(DecorationKind::Tag)
    } else if name.starts_with(b"refs/remotes/") {
        Some(DecorationKind::Remote)
    } else if name == b"refs/stash" {
        Some(DecorationKind::Stash)
    } else if name.starts_with(b"refs/stash/") {
        Some(DecorationKind::Plain)
    } else {
        None
    }
}

/// 引用直接指向的对象，以及顺着标签链剥到底的对象。悬空或过深的符号引用返回 `None`，
/// 和 git 的 `for_each_ref` 跳过坏引用一致。
fn resolve_reference(mut reference: gix::Reference<'_>) -> Option<(gix::ObjectId, gix::ObjectId)> {
    let mut hops = 0;
    let direct = loop {
        if let gix::refs::TargetRef::Object(id) = reference.target() {
            break id.to_owned();
        }
        hops += 1;
        if hops > 5 {
            return None;
        }
        reference = match reference.follow() {
            Some(Ok(next)) => next,
            _ => return None,
        };
    };
    let peeled = reference.peel_to_id().ok()?.detach();
    Some((direct, peeled))
}

/// 装饰相关的引用（含 `refs/replace/*`）在表里的条目；其余命名空间返回 `None`。
fn ref_entry(reference: gix::Reference<'_>) -> Option<(Vec<u8>, RefEntry)> {
    let name = reference.name().as_bstr().to_vec();
    if name.starts_with(b"refs/replace/") {
        return Some((name, RefEntry { symbolic: false, replace: true, resolved: None }));
    }
    let kind = decoration_kind(&name)?;
    let symbolic = matches!(reference.target(), gix::refs::TargetRef::Symbolic(_));
    let resolved = resolve_reference(reference)
        .map(|(direct, peeled)| (peeled, if peeled == direct { kind } else { DecorationKind::Tag }));
    Some((name, RefEntry { symbolic, replace: false, resolved }))
}

/// 读一遍全部引用。读不出来的坏引用跳过，和 git 的 `for_each_ref` 一样。
fn scan_refs(repo: &gix::Repository) -> Result<RefTable, String> {
    #[cfg(test)]
    tests::FULL_SCANS.with(|scans| scans.set(scans.get() + 1));
    let platform = repo.references().map_err(|e| e.to_string())?;
    Ok(platform.all().map_err(|e| e.to_string())?.filter_map(Result::ok).filter_map(ref_entry).collect())
}

/// 两份指纹之间变了的引用名（外加上次的 racy 文件）。`packed-refs` 变了、链接工作树、命名空间、
/// 非 ASCII 的名字（macOS 上要做 Unicode 合成）都返回 `None`，整表重读。`HEAD` 与目录不算：
/// 前者每次重建都重新读，后者的变化总伴随其中文件的变化。
fn changed_refs(
    repo: &gix::Repository, before: &[Stamp], after: &[Stamp], racy: &[std::path::PathBuf],
) -> Option<Vec<Vec<u8>>> {
    let common_dir = repo.common_dir();
    if repo.git_dir() != common_dir || repo.namespace().is_some() {
        return None;
    }
    let index = |stamps: &[Stamp]| -> std::collections::HashMap<std::path::PathBuf, Stamp> {
        stamps.iter().map(|stamp| (stamp.0.clone(), stamp.clone())).collect()
    };
    let (before, after) = (index(before), index(after));
    let mut paths: std::collections::BTreeSet<&std::path::PathBuf> = racy.iter().collect();
    for (path, stamp) in &before {
        if after.get(path) != Some(stamp) {
            paths.insert(path);
        }
    }
    paths.extend(after.keys().filter(|path| !before.contains_key(*path)));
    let refs_dir = common_dir.join("refs");
    let mut names = Vec::new();
    for path in paths {
        let is_dir =
            |stamps: &std::collections::HashMap<std::path::PathBuf, Stamp>| stamps.get(path).is_none_or(|s| s.4);
        if path == &repo.git_dir().join("HEAD") || (is_dir(&before) && is_dir(&after)) {
            continue;
        }
        let relative = path.strip_prefix(&refs_dir).ok()?;
        let mut name = b"refs".to_vec();
        for component in relative.components() {
            let std::path::Component::Normal(part) = component else { return None };
            let part = part.to_str().filter(|part| part.is_ascii())?;
            name.push(b'/');
            name.extend_from_slice(part.as_bytes());
        }
        names.push(name);
    }
    Some(names)
}

/// 上一份引用表按变了的名字就地更新：逐个按全名重新查（松散优先、否则 packed-refs，与遍历一致），
/// 符号引用全部重新解析。名字不合法、读出错误或查到的是别的引用（gix 会像 git 一样补前缀再试）
/// 时返回 `None`，整表重读。
fn refresh_refs(repo: &gix::Repository, table: &RefTable, changed: &[Vec<u8>]) -> Option<RefTable> {
    let mut table = table.clone();
    let symbolic: Vec<Vec<u8>> =
        table.iter().filter(|(_, entry)| entry.symbolic).map(|(name, _)| name.clone()).collect();
    for name in changed.iter().chain(&symbolic) {
        table.remove(name);
        let text = std::str::from_utf8(name).ok()?;
        let full: &gix::refs::FullNameRef = text.try_into().ok()?;
        match repo.try_find_reference(full) {
            Ok(Some(reference)) => {
                if reference.name().as_bstr() != name.as_slice() {
                    return None;
                }
                if let Some((name, entry)) = ref_entry(reference) {
                    table.insert(name, entry);
                }
            }
            Ok(None) => {}
            Err(_) => return None,
        }
    }
    Some(table)
}

fn build_decorations(repo: &gix::Repository) -> Result<Decorations, String> {
    Ok(derive_decorations(repo, &scan_refs(repo)?))
}

fn derive_decorations(repo: &gix::Repository, table: &RefTable) -> Decorations {
    let has_replace = table.values().any(|entry| entry.replace);
    // git 的引用遍历按完整名字的字节序；装饰链表每次头插，所以显示顺序是降序。
    let refs: Vec<(Vec<u8>, gix::ObjectId, DecorationKind)> = table
        .iter()
        .filter_map(|(name, entry)| entry.resolved.map(|(peeled, kind)| (name.clone(), peeled, kind)))
        .collect();

    let mut by_commit: std::collections::HashMap<gix::ObjectId, Vec<Decoration>> = Default::default();
    let mut tags_by_commit: std::collections::HashMap<String, Vec<String>> = Default::default();
    let mut tip_order = Vec::with_capacity(refs.len() + 1);
    for (name, peeled, kind) in refs {
        if name.starts_with(b"refs/heads/") || name.starts_with(b"refs/remotes/") || name.starts_with(b"refs/tags/") {
            tip_order.push(peeled);
        }
        if let Some(tag) = name.strip_prefix(b"refs/tags/") {
            tags_by_commit.entry(peeled.to_string()).or_default().push(String::from_utf8_lossy(tag).into_owned());
        }
        by_commit.entry(peeled).or_default().push(Decoration { kind, name });
    }
    for list in by_commit.values_mut() {
        list.reverse();
    }
    for tags in tags_by_commit.values_mut() {
        tags.sort_by(|a, b| b.cmp(a));
    }

    let head = match repo.head() {
        Err(_) => HeadState::Unsupported,
        Ok(head) => match head.kind {
            gix::head::Kind::Unborn(_) => HeadState::Unborn,
            gix::head::Kind::Detached { target, .. } => HeadState::Detached(target),
            gix::head::Kind::Symbolic(reference) => match reference.target {
                gix::refs::Target::Object(id) => HeadState::Symbolic { branch: reference.name.as_bstr().to_vec(), id },
                gix::refs::Target::Symbolic(_) => HeadState::Unsupported,
            },
        },
    };
    // HEAD 由 `refs_head_ref` 最后加入，因此排在链表最前。指向标签对象时同样剥到提交。
    if let HeadState::Detached(id) | HeadState::Symbolic { id, .. } = head
        && let Ok(object) = repo.find_object(id)
        && let Ok(peeled) = object.peel_tags_to_end()
    {
        let kind = if peeled.id == id { DecorationKind::Head } else { DecorationKind::Tag };
        by_commit.entry(peeled.id).or_default().insert(0, Decoration { kind, name: b"HEAD".to_vec() });
        tip_order.push(peeled.id);
    }

    Decorations {
        by_commit,
        head,
        has_replace,
        tags_by_commit: std::sync::Arc::new(tags_by_commit),
        tip_order,
        graph_tips: Default::default(),
    }
}

/// The reference index rebuilt from scratch, as after any ref change; returns the number of decorated commits.
#[allow(dead_code)] // The benchmark times a rebuild; the app always goes through `decorations`.
pub fn rebuild_ref_index(repo: &gix::Repository) -> Result<usize, String> {
    Ok(build_decorations(repo)?.by_commit.len())
}

/// 指纹先于读引用取：读的过程中有改动，存下的指纹就是旧的，下次一定对不上而重读。
fn decorations(repo: &gix::Repository) -> Result<std::sync::Arc<Decorations>, String> {
    let git_dir = repo.git_dir().to_path_buf();
    let taken = std::time::SystemTime::now();
    let fingerprint = ref_fingerprint(repo);
    let mut cache = REF_INDEX.lock().map_err(|e| e.to_string())?;
    let previous = cache.get(&git_dir);
    if let Some(entry) = previous
        && entry.fingerprint == fingerprint
        && entry.racy.is_empty()
    {
        return Ok(entry.decorations.clone());
    }
    let refreshed = previous.and_then(|entry| {
        let changed = changed_refs(repo, &entry.fingerprint, &fingerprint, &entry.racy)?;
        refresh_refs(repo, &entry.refs, &changed)
    });
    let refs = match refreshed {
        Some(refs) => refs,
        None => scan_refs(repo)?,
    };
    let decorations = std::sync::Arc::new(derive_decorations(repo, &refs));
    let racy = fingerprint
        .iter()
        .filter(|(_, modified, _, _, is_dir)| !is_dir && *modified + RACY_WINDOW >= taken)
        .map(|stamp| stamp.0.clone())
        .collect();
    cache.insert(git_dir, RefIndex { fingerprint, racy, refs, decorations: decorations.clone() });
    Ok(decorations)
}

/// 每个提交上挂着哪些标签（名字降序）。
pub fn tag_index(
    repo: &gix::Repository,
) -> Result<std::sync::Arc<std::collections::HashMap<String, Vec<String>>>, String> {
    Ok(decorations(repo)?.tags_by_commit.clone())
}

/// 提交图的标签索引与遍历起点，同一份引用索引缓存。起点保持 `git log --all` 的顺序（同一时间的
/// 起点按这个顺序入队），重复的只留第一次；标签剥到树或 blob 的不算（git 同样跳过非提交对象）。
pub fn graph_index(repo: &gix::Repository) -> Result<(TagIndex, std::sync::Arc<Vec<gix::ObjectId>>), String> {
    let decorations = decorations(repo)?;
    let tips = decorations
        .graph_tips
        .get_or_init(|| {
            let mut seen = std::collections::HashSet::new();
            let tips = decorations
                .tip_order
                .iter()
                .copied()
                .filter(|id| seen.insert(*id))
                .filter(|id| repo.find_header(*id).is_ok_and(|header| header.kind() == gix::object::Kind::Commit))
                .collect();
            std::sync::Arc::new(tips)
        })
        .clone();
    Ok((decorations.tags_by_commit.clone(), tips))
}

/// 提交 sha → 指向它的标签名（降序）。
pub type TagIndex = std::sync::Arc<std::collections::HashMap<String, Vec<String>>>;

pub fn log(root: &Path, limit: usize, skip: usize) -> Result<Vec<CommitInfo>, String> {
    let repo = gix::open(root).map_err(|e| format!("打开仓库失败: {e}"))?;
    let Ok(head) = repo.head_id() else {
        // 空仓库（还没有任何提交）不是错误
        return Ok(Vec::new());
    };

    let tags_by_commit = tag_index(&repo)?;
    let walk = repo.rev_walk(Some(head.detach())).all().map_err(|e| format!("遍历提交失败: {e}"))?;

    let mut out = Vec::with_capacity(limit);
    for info in walk.skip(skip).take(limit) {
        let info = info.map_err(|e| format!("读取提交失败: {e}"))?;
        let commit = repo.find_object(info.id).map_err(|e| format!("读提交对象失败: {e}"))?.into_commit();

        let msg = commit.message().map_err(|e| format!("解析提交信息失败: {e}"))?;
        let author = commit.author().map_err(|e| format!("解析作者失败: {e}"))?;
        let sha = info.id.to_string();

        out.push(CommitInfo {
            short_sha: sha[..7.min(sha.len())].to_string(),
            tags: tags_by_commit.get(&sha).cloned().unwrap_or_default(),
            sha,
            summary: msg.summary().to_string(),
            body: msg.body.map(|b| b.to_string()).unwrap_or_default(),
            author_name: author.name.to_string(),
            author_email: author.email.to_string(),
            time: author.seconds(),
            parent_count: commit.parent_ids().count() as u32,
            parent_sh_as: commit.parent_ids().map(|id| id.to_string()).collect(),
        });
    }
    Ok(out)
}

/// 两条分支各自独有的提交。
///
/// 「我领先几个 / 落后几个」只是两个数字，真要判断该不该合还得看**是哪些提交**。
/// 原版的 compare 视图就是把这两串列出来（ahead / behind 两个 tab）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    /// 我有、对方没有的
    pub ahead: Vec<CommitInfo>,
    /// 对方有、我没有的
    pub behind: Vec<CommitInfo>,
}

/// `<range>` 里的提交，新的在前。
///
/// 走 git CLI 而不是 gix：gix 的 rev_walk 只接受「从哪些提交开始」，
/// 要表达 `a..b` 这种「减去另一条线」得自己求交集。`git log` 本来就会。
///
/// 记录之间用 \x01 分隔、字段之间用 NUL：提交正文里什么都可能有，
/// 换行分隔是不行的。
fn log_range(root: &Path, range: &str, limit: usize) -> Result<Vec<CommitInfo>, String> {
    query(root, range, Some(limit), None, &[])
}

/// Desktop getCommits argument ordering: explicit revisions must remain included
/// even when --not/--remotes options leave exclusion mode enabled.
pub fn query(
    root: &Path, revision: &str, limit: Option<usize>, skip: Option<usize>, additional: &[String],
) -> Result<Vec<CommitInfo>, String> {
    let mut command = crate::git::Git::new(Some(root)).args([
        "--no-optional-locks",
        "log",
        "--no-show-signature",
        "--no-color",
        "--format=%x01%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%at%x00%P%x00%D",
    ]);
    if let Some(limit) = limit {
        command = command.arg(format!("--max-count={limit}"));
    }
    if let Some(skip) = skip {
        command = command.arg(format!("--skip={skip}"));
    }
    command = command.args(additional);
    if additional.iter().filter(|arg| arg.as_str() == "--not").count() % 2 == 1 {
        command = command.arg("--not");
    }
    let output = command.args(["--end-of-options", revision, "--"]).output()?;
    if output.status.code() == Some(128) {
        return Ok(Vec::new());
    }
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    let out = String::from_utf8_lossy(&output.stdout);

    Ok(out
        .split('\u{1}')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('\0').collect();
            if f.len() < 8 {
                return None;
            }
            Some(CommitInfo {
                tags: f
                    .get(8)
                    .unwrap_or(&"")
                    .trim_end()
                    .split(", ")
                    .filter_map(|r| r.strip_prefix("tag: "))
                    .map(str::to_string)
                    .collect(),
                sha: f[0].to_string(),
                short_sha: f[1].to_string(),
                summary: f[2].to_string(),
                body: f[3].to_string(),
                author_name: f[4].to_string(),
                author_email: f[5].to_string(),
                time: f[6].parse().unwrap_or(0),
                parent_count: f[7].split_whitespace().count() as u32,
                parent_sh_as: f[7].split_whitespace().map(str::to_string).collect(),
            })
        })
        .collect())
}

/// Desktop's full commit contract, retaining distinct author/committer identities
/// and unfolded trailers. NUL-delimited fields also preserve control bytes in messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    sha: String,
    short_sha: String,
    summary: String,
    body: String,
    author: String,
    committer: String,
    parents: String,
    trailers: String,
    refs: String,
}

impl CommitDetails {
    /// 九个字段依次是 `%H %h %s %b "%an <%ae> %ad" "%cn <%ce> %cd" %P %(trailers:unfold,only) %D`。
    /// gix 快速路径和 git 命令都经由这里，字节到字符串的转换只有这一处。
    fn from_fields(f: [&[u8]; 9]) -> Self {
        let text = |i: usize| String::from_utf8_lossy(f[i]).into_owned();
        let bounded = |i: usize| String::from_utf8_lossy(&f[i][..f[i].len().min(100 * 1024)]).into_owned();
        CommitDetails {
            sha: text(0),
            short_sha: text(1),
            summary: bounded(2),
            body: bounded(3),
            author: text(4),
            committer: text(5),
            parents: text(6),
            trailers: text(7),
            refs: text(8),
        }
    }
}

/// 普通的历史翻页（从 HEAD 开始、没有附加参数）在进程内由 gix 完成，
/// 输出与 `details_via_git` 逐字节一致；其余情况及 gix 不能保证一致的仓库仍走 git。
pub fn query_details(
    root: &Path, revision: Option<&str>, limit: Option<usize>, skip: Option<usize>, additional: &[String],
) -> Result<Vec<CommitDetails>, String> {
    // `git log HEAD` is the default walk; Desktop's ported stores page history with that revision.
    match details_via_gix(root, revision, limit, skip, additional) {
        Ok(details) => return Ok(details),
        Err(reason) => log::debug!("history fast path unavailable for {}: {reason}", root.display()),
    }
    details_via_git(root, revision, limit, skip, additional)
}

/// Desktop `getCommits` 的原始命令（app/src/lib/git/log.ts）。
fn details_via_git(
    root: &Path, revision: Option<&str>, limit: Option<usize>, skip: Option<usize>, additional: &[String],
) -> Result<Vec<CommitDetails>, String> {
    details_command(root, revision, limit, skip, additional, &[], None)
}

/// Desktop `getCommits` 的提交格式（app/src/lib/git/log.ts），九个字段以 NUL 分隔。
pub(crate) const DETAILS_FORMAT: &str =
    "--format=%H%x00%h%x00%s%x00%b%x00%an <%ae> %ad%x00%cn <%ce> %cd%x00%P%x00%(trailers:unfold,only)%x00%D";

/// Desktop 命令加上 `--` 后的 pathspec 与 `--stdin` 输入；提交搜索与普通翻页共用同一格式。
fn details_command(
    root: &Path, revision: Option<&str>, limit: Option<usize>, skip: Option<usize>, additional: &[String],
    files: &[String], stdin: Option<String>,
) -> Result<Vec<CommitDetails>, String> {
    let mut command = crate::git::Git::new(Some(root)).args(["log", "--date=raw"]);
    if let Some(stdin) = stdin {
        command = command.stdin(stdin);
    }
    if let Some(limit) = limit {
        command = command.arg(format!("--max-count={limit}"));
    }
    if let Some(skip) = skip {
        command = command.arg(format!("--skip={skip}"));
    }
    command = command.args(["-z", DETAILS_FORMAT, "--no-show-signature", "--no-color"]).args(additional);
    if let Some(revision) = revision {
        if additional.iter().filter(|arg| arg.as_str() == "--not").count() % 2 == 1 {
            command = command.arg("--not");
        }
        command = command.args(["--end-of-options", revision]);
    }
    let output = command.arg("--").args(files).output()?;
    if output.status.code() == Some(128) {
        return Ok(Vec::new());
    }
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    parse_details(&output.stdout)
}

/// `-z` 加 [`DETAILS_FORMAT`] 的输出：每个提交九个字段，每个字段以 NUL 结尾。
pub(crate) fn parse_details(stdout: &[u8]) -> Result<Vec<CommitDetails>, String> {
    let fields: Vec<&[u8]> = stdout.split(|byte| *byte == 0).collect();
    if !(fields.len() - 1).is_multiple_of(9) || fields.last() != Some(&&b""[..]) {
        return Err("Invalid NUL-delimited commit output".into());
    }
    Ok(fields[..fields.len() - 1].as_chunks::<9>().0.iter().map(|f| CommitDetails::from_fields(*f)).collect())
}

impl CommitDetails {
    /// History 列表渲染的形状：`%an <%ae> %ad`（`--date=raw`）拆成姓名、邮箱、秒；`%D` 里只取标签。
    pub fn to_info(&self) -> CommitInfo {
        let (author_name, author_email, time) = split_identity(&self.author);
        CommitInfo {
            sha: self.sha.clone(),
            short_sha: self.short_sha.clone(),
            summary: self.summary.clone(),
            body: self.body.clone(),
            author_name,
            author_email,
            time,
            tags: self.refs.split(", ").filter_map(|r| r.strip_prefix("tag: ")).map(str::to_string).collect(),
            parent_count: self.parents.split_whitespace().count() as u32,
            parent_sh_as: self.parents.split_whitespace().map(str::to_string).collect(),
        }
    }
}

/// `Name <email> 1700000000 +0800` → (Name, email, 1700000000)。
fn split_identity(identity: &str) -> (String, String, i64) {
    let mut parts = identity.rsplitn(3, ' ');
    let _zone = parts.next();
    let seconds = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let rest = parts.next().unwrap_or("");
    let (name, email) = match rest.rfind(" <") {
        Some(index) if rest.ends_with('>') => (&rest[..index], &rest[index + 2..rest.len() - 1]),
        _ => match rest.strip_prefix('<').and_then(|r| r.strip_suffix('>')) {
            Some(email) => ("", email),
            None => (rest, ""),
        },
    };
    (name.to_string(), email.to_string(), seconds)
}

/// GitLens `resolveShas`（packages/git-cli/src/providers/revision.ts）：4–40 位十六进制前缀经
/// `rev-parse --disambiguate` 展开并只保留 commit 对象，其余值原样通过。
pub(crate) fn resolve_shas(root: &Path, shas: &[String]) -> Result<Vec<String>, String> {
    let mut resolved: Vec<String> = Vec::new();
    let mut add = |value: String| {
        if !resolved.contains(&value) {
            resolved.push(value);
        }
    };
    let mut prefixes: Vec<&str> = Vec::new();
    for value in shas {
        if (4..=40).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit()) {
            prefixes.push(value);
        } else {
            add(value.clone());
        }
    }
    if !prefixes.is_empty() {
        let listing = crate::git::Git::new(Some(root))
            .arg("rev-parse")
            .args(prefixes.iter().map(|prefix| format!("--disambiguate={prefix}")))
            .output()?;
        let stdout = String::from_utf8_lossy(&listing.stdout).into_owned();
        let oids: Vec<&str> = stdout.lines().filter(|line| !line.is_empty()).collect();
        if !oids.is_empty() {
            let kinds = crate::git::Git::new(Some(root))
                .args(["cat-file", "--batch-check=%(objectname) %(objecttype)"])
                .stdin(format!("{}\n", oids.join("\n")))
                .output()?;
            for line in String::from_utf8_lossy(&kinds.stdout).lines() {
                if let Some((oid, kind)) = line.split_once(' ')
                    && kind == "commit"
                {
                    add(oid.to_string());
                }
            }
        }
    }
    Ok(resolved)
}

/// GitLens `convertStashesToStdin`：每个贮藏及其第 2、3 个父提交（索引、未跟踪文件）的 9 位前缀
/// 作为 `--stdin` 输入，并把这些 sha 都映射回所属贮藏。
fn stashes_to_stdin(
    stashes: &[crate::ops::StashEntry],
) -> (std::collections::HashMap<String, crate::ops::StashEntry>, Option<String>) {
    let mut map = std::collections::HashMap::new();
    let mut stdin = String::new();
    for stash in stashes {
        map.insert(stash.sha.clone(), stash.clone());
        stdin.push_str(&stash.sha[..stash.sha.len().min(9)]);
        stdin.push('\n');
        for parent in stash.parents.iter().skip(1) {
            if !map.contains_key(parent) {
                map.insert(parent.clone(), stash.clone());
                stdin.push_str(&parent[..parent.len().min(9)]);
                stdin.push('\n');
            }
        }
    }
    (map, (!stdin.is_empty()).then_some(stdin))
}

/// 提交搜索：GitLens `searchCommits`（packages/git-cli/src/providers/commits.ts，c1f6e5f3c）
/// 在 Desktop 提交格式上的对应实现。
///
/// 查询语法由 `search_query` 解析（`validate = true`，错误原样返回给界面）；`@me` 取仓库的
/// `user.name`。`commit:` 先解析 sha 再 `--no-walk --stdin`；其余情况 `--all`（`ref:` 时换成指定
/// 引用）并把贮藏及其父提交喂进 `--stdin`，`type:merge` 时不喂；`-n limit+1` 与 `--skip` 和
/// 原版一致。结果过滤照搬 `parseCommits`：`type:stash` 只留贮藏、`type:merge` 去掉贮藏、
/// `type:tip` 只留带引用的提交；`type:wip` 原版没有后置过滤，这里同样不过滤。匹配到贮藏的
/// 索引／未跟踪父提交时归并为所属贮藏，只计一次。
pub fn search(
    root: &Path, search: &crate::search_query::SearchQuery, limit: usize, skip: usize,
) -> Result<Vec<CommitInfo>, String> {
    use crate::search_query::{GitUser, SearchQuery, parse_search_query, parse_search_query_git_command};

    let search = SearchQuery {
        match_all: Some(search.match_all.unwrap_or(false)),
        match_case: Some(search.match_case.unwrap_or(false)),
        match_regex: Some(search.match_regex.unwrap_or(true)),
        match_whole_word: Some(search.match_whole_word.unwrap_or(false)),
        ..search.clone()
    };
    if search.query.trim().is_empty() {
        return Ok(Vec::new());
    }
    if let Some(errors) = parse_search_query(&search, true).errors {
        return Err(errors.join("\n"));
    }

    let current_user = crate::git_config::get(Some(root), "user.name", false, false)?
        .filter(|name| !name.is_empty())
        .map(|name| GitUser { name: Some(name), ..Default::default() });
    let command = parse_search_query_git_command(&search, current_user.as_ref());
    // Stash commits have 2-3 parents, so `--merges` matches them; excluded below. Derived from the
    // args git actually runs rather than `filters.type` (multi-value `type:` keeps the last value).
    let merges_only = command.args.iter().any(|arg| arg == "--merges");

    let mut args: Vec<String> = Vec::new();
    let mut stashes = std::collections::HashMap::new();
    let mut stdin: Option<String> = None;

    if let Some(shas) = &command.shas {
        let resolved = resolve_shas(root, shas)?;
        // Short SHA(s) matched no commit: empty stdin to `--no-walk --stdin` would return HEAD.
        if resolved.is_empty() {
            return Ok(Vec::new());
        }
        stdin = Some(resolved.join("\n"));
        args.push("--no-walk".into());
    } else if !command.filters.refs {
        // Don't include stashes when using ref: filter, as they would add unrelated commits
        let (map, converted) = stashes_to_stdin(&crate::ops::stashes(root)?);
        stashes = map;
        // `--all` already surfaces refs/stash's tip on its own, so when merges-only there's no need
        // to walk the rest of the stash stack via stdin
        stdin = if merges_only { None } else { converted };
    } else if merges_only {
        // A stash's tip can still leak in via `--merges` if the ref reaches refs/stash
        stashes = stashes_to_stdin(&crate::ops::stashes(root)?).0;
    }

    if stdin.is_some() {
        args.push("--stdin".into());
    }

    let max_count = (limit > 0 && command.shas.is_none()).then_some(limit + 1);

    // Add the search args, but skip any shas (as they are already included in the stdin)
    for arg in &command.args {
        if command.shas.as_ref().is_some_and(|shas| shas.contains(arg)) || args.contains(arg) {
            continue;
        }
        args.push(arg.clone());
    }

    let parsed = details_command(root, None, max_count, (skip > 0).then_some(skip), &args, &command.files, stdin)?;

    let tips_only = command.filters.kind.as_deref() == Some("tip");
    let stashes_only = command.filters.kind.as_deref() == Some("stash");
    let mut emitted_stashes = std::collections::HashSet::new();
    let mut count = 0;
    let mut commits = Vec::new();
    for commit in &parsed {
        if !stashes.is_empty() {
            if stashes_only && !stashes.contains_key(&commit.sha) {
                continue;
            }
            if merges_only && stashes.contains_key(&commit.sha) {
                continue;
            }
        }
        if tips_only && commit.refs.is_empty() {
            continue;
        }

        count += 1;
        if limit > 0 && count > limit {
            break;
        }

        if let Some(stash) = stashes.get(&commit.sha) {
            if !emitted_stashes.insert(stash.sha.clone()) {
                continue;
            }
            if commit.sha == stash.sha {
                commits.push(commit.to_info());
            } else if let Some(details) = details_via_git(root, Some(&stash.sha), Some(1), None, &[])?.first() {
                commits.push(details.to_info());
            }
            continue;
        }

        commits.push(commit.to_info());
    }
    Ok(commits)
}

/// 排序走到的提交从哪里取父提交：在 commit-graph 里的只记位置（git 的
/// `parse_commit_in_graph` 同样不读对象），不在的才解码对象并留着给输出用。
enum Walkable {
    Graph(gix::commitgraph::Position),
    Object(Vec<u8>),
}

/// `git log` 的默认遍历：按提交时间降序，时间相同按入队先后（commit.c
/// `commit_list_insert_by_date`）。`BinaryHeap` 取最大值，所以序号反向比较。
struct Walked {
    date: u64,
    seq: u64,
    id: gix::ObjectId,
    source: Walkable,
}

impl PartialEq for Walked {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == std::cmp::Ordering::Equal
    }
}
impl Eq for Walked {}
impl PartialOrd for Walked {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Walked {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.date.cmp(&other.date).then_with(|| other.seq.cmp(&self.seq))
    }
}

/// 让快速路径让位给 git 的配置：这些键会改变 `git log` 的输出，而 gix 侧没有照搬。
fn fast_path_config_blocker(repo: &gix::Repository) -> Option<String> {
    let config = repo.config_snapshot();
    let value = |key: &str| config.string(key).map(|value| value.to_string());
    if let Some(decorate) = value("log.decorate") {
        let decorate = decorate.trim().to_ascii_lowercase();
        if !matches!(decorate.as_str(), "short" | "auto" | "true" | "yes" | "on" | "1" | "false" | "no" | "off" | "0") {
            return Some(format!("log.decorate={decorate}"));
        }
    }
    if value("log.excludeDecoration").is_some() {
        return Some("log.excludeDecoration".into());
    }
    if value("log.initialDecorationSet").is_some_and(|set| set.trim().eq_ignore_ascii_case("all")) {
        return Some("log.initialDecorationSet=all".into());
    }
    if config.plumbing().sections_by_name("trailer").is_some_and(|mut sections| sections.next().is_some()) {
        return Some("trailer.* configuration".into());
    }
    for key in ["core.commentChar", "core.commentString"] {
        if value(key).is_some_and(|comment| comment != "#") {
            return Some(key.into());
        }
    }
    for key in ["i18n.logOutputEncoding", "i18n.commitEncoding"] {
        if value(key).is_some_and(|encoding| !log_format::is_utf8_name(encoding.trim())) {
            return Some(key.into());
        }
    }
    None
}

/// `%h` 的起始长度（odb.c `odb_find_abbrev_len`）：`core.abbrev` 为数字时直接用，
/// 否则按打包对象数估算——git 只数 pack 和 multi-pack-index 里的对象，不数松散对象。
pub(crate) fn abbreviation_length(repo: &gix::Repository) -> Result<usize, String> {
    let hexsz = repo.object_hash().len_in_hex();
    let configured = repo.config_snapshot().string("core.abbrev").map(|value| value.to_string());
    let len = match configured.as_deref().map(str::trim) {
        None => None,
        Some(auto) if auto.eq_ignore_ascii_case("auto") => None,
        Some(number) => match number.parse::<usize>() {
            Ok(len) if (4..=hexsz).contains(&len) => Some(len),
            _ => return Err(format!("core.abbrev={number}")),
        },
    };
    let len = match len {
        Some(len) => len,
        None => {
            let count = repo.objects.packed_object_count().map_err(|e| e.to_string())?;
            let bits = (u64::BITS - count.leading_zeros()) as usize;
            bits.div_ceil(2).max(7)
        }
    };
    Ok(len.min(hexsz))
}

fn short_id(repo: &gix::Repository, id: gix::ObjectId, hex_len: usize) -> Result<String, String> {
    if hex_len >= id.kind().len_in_hex() {
        return Ok(id.to_string());
    }
    let candidate = gix::odb::store::prefix::disambiguate::Candidate::new(id, hex_len).map_err(|e| e.to_string())?;
    let prefix = repo.objects.disambiguate_prefix(candidate).map_err(|e| e.to_string())?;
    prefix.map(|prefix| prefix.to_string()).ok_or_else(|| format!("object {id} vanished while abbreviating"))
}

fn load_commit(repo: &gix::Repository, id: gix::ObjectId) -> Result<Vec<u8>, String> {
    let object = repo.find_object(id).map_err(|e| e.to_string())?;
    if object.kind != gix::object::Kind::Commit {
        return Err(format!("{id} is a {} rather than a commit", object.kind));
    }
    Ok(object.detach().data)
}

/// 进程内 `git log`（Desktop 提交格式）的公共部分：打开仓库、检查让位条件，并按 git 的规则
/// 渲染单个提交。普通历史翻页与文件历史（`file_history.rs`）共用。
pub(crate) struct FastLog {
    pub(crate) repo: gix::Repository,
    decorations: std::sync::Arc<Decorations>,
    pub(crate) hexsz: usize,
    hex_len: usize,
    /// git 开着 core.commitGraph（默认）且图可用时，排序日期和父提交都来自图
    /// （34 位截断的时间戳也照搬）；图打不开就和 git 一样当作没有。
    pub(crate) graph: Option<gix::commitgraph::Graph>,
}

impl FastLog {
    /// `Err` 只表示「这个仓库不走快速路径」，不是失败。
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        let mut repo = gix::open(root).map_err(|e| e.to_string())?;
        repo.object_cache_size_if_unset(4 * 1024 * 1024);
        // 对象库只在本次调用首次访问时扫描一遍 pack 目录。默认模式下每次 `%h` 前缀查找
        // 走完全部索引后都会重新扫描目录（Desktop 仓库 39 个 pack，一页 100 次扫描占 27 ms）；
        // git 本身也只在进程启动时准备一次 pack 列表。期间新写入的对象找不到时整页让位给 git。
        repo.objects.refresh_never();
        if let Some(blocker) = fast_path_config_blocker(&repo) {
            return Err(blocker);
        }
        if repo.is_shallow().map_err(|e| e.to_string())? {
            return Err("shallow repository".into());
        }
        if repo.common_dir().join("info").join("grafts").exists() {
            return Err("info/grafts".into());
        }
        let decorations = decorations(&repo)?;
        if decorations.has_replace {
            return Err("refs/replace".into());
        }
        // HEAD 的装饰（`HEAD -> branch`）也依赖它，所以任何修订号都要求 HEAD 可解析。
        if matches!(decorations.head, HeadState::Unsupported) {
            return Err("HEAD is not a plain branch or commit".into());
        }
        let hexsz = repo.object_hash().len_in_hex();
        let hex_len = abbreviation_length(&repo)?;
        let graph = repo.commit_graph_if_enabled().ok().flatten();
        Ok(FastLog { repo, decorations, hexsz, hex_len, graph })
    }

    /// HEAD 指向的对象；未出生的 HEAD 为 `None`（git 以 128 退出，调用方当作空）。
    pub(crate) fn head(&self) -> Option<gix::ObjectId> {
        match &self.decorations.head {
            HeadState::Detached(id) | HeadState::Symbolic { id, .. } => Some(*id),
            HeadState::Unborn | HeadState::Unsupported => None,
        }
    }

    /// 起点剥掉标签后必须是提交。
    pub(crate) fn peel_commit(&self, id: gix::ObjectId) -> Result<gix::ObjectId, String> {
        let object =
            self.repo.find_object(id).map_err(|e| e.to_string())?.peel_tags_to_end().map_err(|e| e.to_string())?;
        if object.kind != gix::object::Kind::Commit {
            return Err(format!("{id} points at a {}", object.kind));
        }
        Ok(object.id)
    }

    /// 一个提交在 Desktop 格式下的九个字段。
    pub(crate) fn render(&self, id: gix::ObjectId, data: &[u8]) -> Result<CommitDetails, String> {
        let commit = log_format::parse_commit(data, self.hexsz)?;
        if commit.has_encoding_header {
            return Err(format!("{id} carries an encoding header"));
        }
        let sha = id.to_string();
        let short = short_id(&self.repo, id, self.hex_len)?;
        let message = log_format::Message::new(commit.message);
        let author = log_format::format_person(commit.author)
            .ok_or_else(|| format!("{sha} has an author line git cannot split"))?;
        let committer = log_format::format_person(commit.committer)
            .ok_or_else(|| format!("{sha} has a committer line git cannot split"))?;
        let parents = commit.parents.iter().map(ToString::to_string).collect::<Vec<_>>().join(" ");
        let trailers = log_format::trailers_only_unfold(message.starting_at_subject());
        let refs = format_decorations(id, &self.decorations);
        Ok(CommitDetails::from_fields([
            sha.as_bytes(),
            short.as_bytes(),
            &message.subject(),
            message.body(),
            &author,
            &committer,
            parents.as_bytes(),
            &trailers,
            &refs,
        ]))
    }

    /// 提交的根树：在 commit-graph 里的直接取，不在的解码对象的第一行。
    pub(crate) fn root_tree(&self, id: gix::ObjectId) -> Result<gix::ObjectId, String> {
        if let Some(graph) = &self.graph
            && let Some(pos) = graph.lookup(id)
        {
            return Ok(graph.commit_at(pos).root_tree_id().to_owned());
        }
        tree_line(&load_commit(&self.repo, id)?, self.hexsz)
    }
}

/// commit.c `parse_commit_buffer` 的第一行 `tree <hex>`。
fn tree_line(data: &[u8], hexsz: usize) -> Result<gix::ObjectId, String> {
    data.strip_prefix(b"tree ")
        .and_then(|rest| rest.get(..hexsz))
        .ok_or_else(|| "bogus commit object".to_string())
        .and_then(|hex| gix::ObjectId::from_hex(hex).map_err(|e| e.to_string()))
}

/// [`DateWalk`] 走到的一个提交：父提交、根树；从对象解码的还带着提交数据，图里的没有。
pub(crate) struct Step {
    pub(crate) id: gix::ObjectId,
    pub(crate) parents: Vec<gix::ObjectId>,
    pub(crate) tree: gix::ObjectId,
    data: Option<Vec<u8>>,
}

impl Step {
    pub(crate) fn take_data(&mut self, repo: &gix::Repository) -> Result<Vec<u8>, String> {
        match self.data.take() {
            Some(data) => Ok(data),
            None => load_commit(repo, self.id),
        }
    }
}

/// 不受限的 `git log` 遍历（revision.c `get_revision_1`，`revs->limited` 为 0）：
/// 起点去重后按日期稳定排序入队，之后每次取出最新的提交并把没见过的父提交按日期入队。
pub(crate) struct DateWalk<'a> {
    log: &'a FastLog,
    heap: std::collections::BinaryHeap<Walked>,
    seen: std::collections::HashSet<gix::ObjectId>,
    seq: u64,
}

impl<'a> DateWalk<'a> {
    pub(crate) fn new(log: &'a FastLog, tips: impl IntoIterator<Item = gix::ObjectId>) -> Result<Self, String> {
        let mut walk = DateWalk { log, heap: Default::default(), seen: Default::default(), seq: 0 };
        // prepare_revision_walk：起点去重后按日期稳定排序，再按序入队。
        let mut starts = Vec::new();
        for id in tips {
            if walk.seen.insert(id) {
                let (date, source) = walk.describe(id)?;
                starts.push(Walked { date, seq: 0, id, source });
            }
        }
        starts.sort_by_key(|start| std::cmp::Reverse(start.date));
        for mut start in starts {
            start.seq = walk.seq;
            walk.seq += 1;
            walk.heap.push(start);
        }
        Ok(walk)
    }

    /// 交出队列、已见集合与入队序号，留给下一次调用接着走（文件历史翻页）。
    pub(crate) fn into_state(self) -> WalkState {
        WalkState { heap: self.heap, seen: self.seen, seq: self.seq }
    }

    /// 用重新打开的仓库接着上次的状态走。队列里每个提交按现在的仓库重新定位（commit-graph
    /// 可能已重写、位置不再有效），排序日期必须和保存时相同，否则 `Err`，调用方从头走。
    pub(crate) fn resume(log: &'a FastLog, state: WalkState) -> Result<Self, String> {
        let mut walk = DateWalk { log, heap: Default::default(), seen: state.seen, seq: state.seq };
        let mut heap = Vec::with_capacity(state.heap.len());
        for walked in state.heap.into_vec() {
            let (date, source) = walk.describe(walked.id)?;
            if date != walked.date {
                return Err(format!("{} sorts differently now", walked.id));
            }
            heap.push(Walked { date, seq: walked.seq, id: walked.id, source });
        }
        walk.heap = heap.into();
        Ok(walk)
    }

    fn describe(&self, id: gix::ObjectId) -> Result<(u64, Walkable), String> {
        if let Some(graph) = &self.log.graph
            && let Some(pos) = graph.lookup(id)
        {
            return Ok((graph.commit_at(pos).committer_timestamp(), Walkable::Graph(pos)));
        }
        let data = load_commit(&self.log.repo, id)?;
        let date = log_format::parse_commit(&data, self.log.hexsz)?.date;
        Ok((date, Walkable::Object(data)))
    }

    pub(crate) fn next_step(&mut self) -> Result<Option<Step>, String> {
        let Some(walked) = self.heap.pop() else { return Ok(None) };
        let mut parents = Vec::new();
        let (tree, data) = match walked.source {
            Walkable::Graph(pos) => {
                let graph = self.log.graph.as_ref().expect("graph positions only exist with a graph");
                let commit = graph.commit_at(pos);
                for parent in commit.iter_parents() {
                    let parent = parent.map_err(|e| e.to_string())?;
                    let id = graph.id_at(parent).to_owned();
                    parents.push(id);
                    if self.seen.insert(id) {
                        self.seq += 1;
                        let date = graph.commit_at(parent).committer_timestamp();
                        self.heap.push(Walked { date, seq: self.seq, id, source: Walkable::Graph(parent) });
                    }
                }
                (commit.root_tree_id().to_owned(), None)
            }
            Walkable::Object(data) => {
                parents.extend(log_format::parse_commit(&data, self.log.hexsz)?.parents);
                for parent in &parents {
                    if self.seen.insert(*parent) {
                        let (date, source) = self.describe(*parent)?;
                        self.seq += 1;
                        self.heap.push(Walked { date, seq: self.seq, id: *parent, source });
                    }
                }
                (tree_line(&data, self.log.hexsz)?, Some(data))
            }
        };
        Ok(Some(Step { id: walked.id, parents, tree, data }))
    }
}

/// [`DateWalk::into_state`] 保存的遍历状态，不借用仓库。
pub(crate) struct WalkState {
    heap: std::collections::BinaryHeap<Walked>,
    seen: std::collections::HashSet<gix::ObjectId>,
    seq: u64,
}

/// `git log --date=raw -z --format=… --no-show-signature --no-color [<revision>] --` 的进程内实现。
/// `Err` 只表示「这个仓库或这次查询不走快速路径」，不是失败。
fn details_via_gix(
    root: &Path, revision: Option<&str>, limit: Option<usize>, skip: Option<usize>, additional: &[String],
) -> Result<Vec<CommitDetails>, String> {
    let log = FastLog::open(root)?;
    let tips = match revision {
        // 不带修订号和 `HEAD` 一样从 HEAD 开始；未出生的 HEAD 没有提交（git 以 128 退出，调用方当作空）。
        None | Some("HEAD") if additional.is_empty() => match log.head() {
            None => return Ok(Vec::new()),
            Some(id) => vec![(id, false)],
        },
        _ => revision_tips(&log.repo, &log.decorations, revision, additional)?,
    };
    if limit == Some(0) {
        return Ok(Vec::new());
    }
    let mut tips_peeled = Vec::with_capacity(tips.len());
    for (id, uninteresting) in tips {
        tips_peeled.push((log.peel_commit(id)?, uninteresting));
    }
    let skip = skip.unwrap_or(0);
    if tips_peeled.iter().any(|(_, uninteresting)| *uninteresting) {
        // revision.c `handle_commit`：有排除的起点时 `revs->limited = 1`，先由 `limit_list`
        // 求出全部感兴趣的提交，再按顺序输出。
        let tips: Vec<_> = tips_peeled.iter().map(|(id, uninteresting)| (*id, *uninteresting, false)).collect();
        let ids = limited_walk(&log.repo, log.graph.as_ref(), log.hexsz, &tips)?;
        let mut out = Vec::with_capacity(limit.unwrap_or(ids.len()).min(ids.len()));
        for (id, _) in ids.into_iter().skip(skip) {
            out.push(log.render(id, &load_commit(&log.repo, id)?)?);
            if limit == Some(out.len()) {
                break;
            }
        }
        return Ok(out);
    }

    let mut walk = DateWalk::new(&log, tips_peeled.into_iter().map(|(id, _)| id))?;
    let mut skipped = 0;
    let mut out = Vec::with_capacity(limit.unwrap_or(0).min(1024));
    while let Some(mut step) = walk.next_step()? {
        if skipped < skip {
            skipped += 1;
            continue;
        }
        let id = step.id;
        out.push(log.render(id, &step.take_data(&log.repo)?)?);
        if limit == Some(out.len()) {
            break;
        }
    }
    Ok(out)
}

/// `git rev-list --left-right --count A...B --` 的进程内实现（Desktop `getAheadBehind`）。
/// revision.c `handle_dotdot_1` 的对称差：合并基作为排除端先入 pending，A 带 SYMMETRIC_LEFT，
/// 然后同一个受限遍历；计数只看输出集合。`Err` 表示交给 git。
pub fn left_right_counts(root: &Path, range: &str) -> Result<(u32, u32), String> {
    let (a, b) = range.split_once("...").ok_or("not a symmetric range")?;
    if a.contains("..") || b.contains("..") {
        return Err("unsupported range".into());
    }
    let mut repo = gix::open(root).map_err(|e| e.to_string())?;
    repo.object_cache_size_if_unset(4 * 1024 * 1024);
    repo.objects.refresh_never();
    if repo.is_shallow().map_err(|e| e.to_string())? {
        return Err("shallow repository".into());
    }
    if repo.common_dir().join("info").join("grafts").exists() {
        return Err("info/grafts".into());
    }
    let decorations = decorations(&repo)?;
    if decorations.has_replace {
        return Err("refs/replace".into());
    }
    let peel = |name: &str| -> Result<gix::ObjectId, String> {
        let name = if name.is_empty() { "HEAD" } else { name };
        let id = resolve_name(&repo, &decorations, name)?;
        let object = repo.find_object(id).map_err(|e| e.to_string())?.peel_tags_to_end().map_err(|e| e.to_string())?;
        if object.kind != gix::object::Kind::Commit {
            return Err(format!("{name} is not a commit"));
        }
        Ok(object.id)
    };
    let (a, b) = (peel(a)?, peel(b)?);
    let bases = repo.merge_bases_many(a, &[b]).map_err(|e| e.to_string())?;
    let mut tips: Vec<_> = bases.into_iter().map(|id| (id.detach(), true, false)).collect();
    tips.push((a, false, true));
    tips.push((b, false, false));
    let graph = repo.commit_graph_if_enabled().ok().flatten();
    let hexsz = repo.object_hash().len_in_hex();
    let mut counts = (0u32, 0u32);
    for (_, left) in limited_walk(&repo, graph.as_ref(), hexsz, &tips)? {
        if left {
            counts.0 += 1;
        } else {
            counts.1 += 1;
        }
    }
    Ok(counts)
}

/// Desktop `getCommits` 实际传入的修订号形状里，快速路径接管的几种：
/// 单个修订号、`A..B`（任一侧为空即 HEAD），以及 `--not --remotes` 加单个修订号
/// （`details_command` 为奇数个 `--not` 补一个 `--not`，修订号本身仍是感兴趣的）。
/// 返回值按 git 的 pending 顺序排列，`true` 表示 UNINTERESTING。
fn revision_tips(
    repo: &gix::Repository, decorations: &Decorations, revision: Option<&str>, additional: &[String],
) -> Result<Vec<(gix::ObjectId, bool)>, String> {
    let Some(revision) = revision else { return Err("additional arguments without a revision".into()) };
    let mut tips = Vec::new();
    match additional {
        [] => {}
        [not, remotes] if not == "--not" && remotes == "--remotes" => {
            if revision.contains("..") {
                return Err("range combined with --not --remotes".into());
            }
            // revision.c `handle_refs` + refs.c `refs_for_each_remote_ref`：按引用名顺序，
            // 符号引用解析到目标；有坏引用时 git 会跳过并警告，这里整体让位。
            let platform = repo.references().map_err(|e| e.to_string())?;
            for reference in platform.prefixed("refs/remotes/").map_err(|e| e.to_string())? {
                let name = reference.map_err(|e| e.to_string())?.name().as_bstr().to_string();
                // 迭代出的符号引用不能直接 follow，按完整名重新取一次。
                let reference = repo.find_reference(name.as_str()).map_err(|e| e.to_string())?;
                let (_, peeled) = resolve_reference(reference).ok_or_else(|| format!("broken remote ref {name}"))?;
                tips.push((peeled, true));
            }
        }
        _ => return Err(format!("unsupported arguments {additional:?}")),
    }
    // revision.c `handle_dotdot`：`A...B` 需要合并基，交给 git。
    if let Some((a, b)) = revision.split_once("..") {
        if b.starts_with('.') {
            return Err("symmetric difference".into());
        }
        let a = if a.is_empty() { "HEAD" } else { a };
        let b = if b.is_empty() { "HEAD" } else { b };
        tips.push((resolve_name(repo, decorations, a)?, true));
        tips.push((resolve_name(repo, decorations, b)?, false));
    } else {
        tips.push((resolve_name(repo, decorations, revision)?, false));
    }
    Ok(tips)
}

/// object-name.c `get_oid_basic` 的子集：完整十六进制对象名，或按 refs.c
/// `ref_rev_parse_rules` 的顺序找到的第一个引用。其余语法（`^`、`~`、`@{…}`、短对象名、
/// 根目录下的伪引用等）交给 git。
fn resolve_name(repo: &gix::Repository, decorations: &Decorations, name: &str) -> Result<gix::ObjectId, String> {
    if name == "HEAD" {
        return match &decorations.head {
            HeadState::Detached(id) | HeadState::Symbolic { id, .. } => Ok(*id),
            _ => Err("HEAD is unborn or unsupported".into()),
        };
    }
    let hexsz = repo.object_hash().len_in_hex();
    if name.len() == hexsz && name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        let id = gix::ObjectId::from_hex(name.as_bytes()).map_err(|e| e.to_string())?;
        if !repo.has_object(id) {
            return Err(format!("{name} is not in the object database"));
        }
        return Ok(id);
    }
    let reserved = |byte: u8| byte < 0x20 || byte == 0x7f || b" ~^:?*[\\".contains(&byte);
    if name.is_empty() || name.starts_with(['-', '.', '/']) || name.contains("@{") || name.bytes().any(reserved) {
        return Err(format!("revision syntax {name:?}"));
    }
    // `%.*s` 规则：`refs/` 开头的名字按原样解析；其余顶层名字只有 git 目录里真有同名文件
    // （FETCH_HEAD、ORIG_HEAD 等）才会命中，这种情况交给 git。
    if !name.starts_with("refs/") && (repo.git_dir().join(name).exists() || repo.common_dir().join(name).exists()) {
        return Err(format!("{name} names a root ref"));
    }
    let candidates = [
        (name.starts_with("refs/")).then(|| name.to_string()),
        Some(format!("refs/{name}")),
        Some(format!("refs/tags/{name}")),
        Some(format!("refs/heads/{name}")),
        Some(format!("refs/remotes/{name}")),
        Some(format!("refs/remotes/{name}/HEAD")),
    ];
    for full in candidates.into_iter().flatten() {
        let Ok(full_name) = gix::refs::FullName::try_from(full.as_str()) else { continue };
        let reference = repo.try_find_reference(full_name.as_ref()).map_err(|e| e.to_string())?;
        let Some(reference) = reference else { continue };
        // gix 对完整名也会按自己的规则继续尝试；只接受与候选名完全相同的引用。
        if reference.name().as_bstr() != full.as_bytes() {
            continue;
        }
        return resolve_reference(reference).map(|(_, peeled)| peeled).ok_or_else(|| format!("broken ref {full}"));
    }
    Err(format!("{name} is not a ref"))
}

/// revision.c 受限遍历里一个提交的状态：`parents` 为 `Some` 即 git 的「已解析」。
#[derive(Default)]
struct LimitedNode {
    date: u64,
    parents: Option<Vec<gix::ObjectId>>,
    uninteresting: bool,
    /// SYMMETRIC_LEFT：`A...B` 左侧可达。
    left: bool,
    seen: bool,
    added: bool,
    queued: bool,
}

/// revision.c `prepare_revision_walk` + `limit_list` 在没有路径、日期和对称差参数时的逐步照搬，
/// 起点为（提交、UNINTERESTING、SYMMETRIC_LEFT）；返回最终输出顺序及每个提交的左侧标记
/// （输出时已被标为 UNINTERESTING 的提交已剔除）。
fn limited_walk(
    repo: &gix::Repository, graph: Option<&gix::commitgraph::Graph>, hexsz: usize, tips: &[(gix::ObjectId, bool, bool)],
) -> Result<Vec<(gix::ObjectId, bool)>, String> {
    const SLOP: u32 = 5;
    struct Walk<'a> {
        repo: &'a gix::Repository,
        graph: Option<&'a gix::commitgraph::Graph>,
        hexsz: usize,
        nodes: std::collections::HashMap<gix::ObjectId, LimitedNode>,
        heap: std::collections::BinaryHeap<(u64, std::cmp::Reverse<u64>, gix::ObjectId)>,
        seq: u64,
        /// 队列里仍感兴趣的提交数，代替 `everybody_uninteresting` 的整表扫描。
        interesting_queued: usize,
    }
    impl Walk<'_> {
        fn parse(&mut self, id: gix::ObjectId) -> Result<(), String> {
            if self.nodes.get(&id).is_some_and(|node| node.parents.is_some()) {
                return Ok(());
            }
            let (date, parents) = if let Some(graph) = self.graph
                && let Some(pos) = graph.lookup(id)
            {
                let commit = graph.commit_at(pos);
                let mut parents = Vec::new();
                for parent in commit.iter_parents() {
                    parents.push(graph.id_at(parent.map_err(|e| e.to_string())?).to_owned());
                }
                (commit.committer_timestamp(), parents)
            } else {
                let data = load_commit(self.repo, id)?;
                let commit = log_format::parse_commit(&data, self.hexsz)?;
                (commit.date, commit.parents)
            };
            let node = self.nodes.entry(id).or_default();
            node.date = date;
            node.parents = Some(parents);
            Ok(())
        }
        fn set_uninteresting(&mut self, id: gix::ObjectId) -> bool {
            let node = self.nodes.entry(id).or_default();
            if node.uninteresting {
                return false;
            }
            node.uninteresting = true;
            if node.queued {
                self.interesting_queued -= 1;
            }
            true
        }
        fn parents_of(&self, id: gix::ObjectId) -> Vec<gix::ObjectId> {
            self.nodes.get(&id).and_then(|node| node.parents.clone()).unwrap_or_default()
        }
        /// revision.c `mark_parents_uninteresting`：沿已解析的部分向下传播。
        fn mark_parents_uninteresting(&mut self, id: gix::ObjectId) {
            let mut pending = Vec::new();
            for parent in self.parents_of(id) {
                if self.set_uninteresting(parent) {
                    pending.extend(self.parents_of(parent));
                }
            }
            while let Some(next) = pending.pop() {
                if self.set_uninteresting(next) {
                    pending.extend(self.parents_of(next));
                }
            }
        }
        /// commit.c `commit_list_insert_by_date`：同日期排在已有条目之后。
        fn queue(&mut self, id: gix::ObjectId) {
            let node = self.nodes.get_mut(&id).expect("queued commits are parsed");
            node.queued = true;
            if !node.uninteresting {
                self.interesting_queued += 1;
            }
            self.heap.push((node.date, std::cmp::Reverse(self.seq), id));
            self.seq += 1;
        }
        fn pop(&mut self) -> Option<gix::ObjectId> {
            let (_, _, id) = self.heap.pop()?;
            let node = self.nodes.get_mut(&id).expect("queued commits are tracked");
            node.queued = false;
            if !node.uninteresting {
                self.interesting_queued -= 1;
            }
            Some(id)
        }
        /// revision.c `process_parents`，不带路径简化与 first-parent。
        fn process_parents(&mut self, id: gix::ObjectId) -> Result<(), String> {
            let node = self.nodes.get_mut(&id).expect("processed commits are tracked");
            if node.added {
                return Ok(());
            }
            node.added = true;
            let uninteresting = node.uninteresting;
            let left = node.left;
            for parent in self.parents_of(id) {
                if uninteresting {
                    self.set_uninteresting(parent);
                }
                self.parse(parent)?;
                if uninteresting && !self.parents_of(parent).is_empty() {
                    self.mark_parents_uninteresting(parent);
                }
                let node = self.nodes.get_mut(&parent).expect("parsed above");
                // 只有感兴趣的提交把 pass_flags 传给父提交（已入队的父提交也要带上）。
                if !uninteresting && left {
                    node.left = true;
                }
                if !node.seen {
                    node.seen = true;
                    self.queue(parent);
                }
            }
            Ok(())
        }
    }

    let mut walk = Walk {
        repo,
        graph,
        hexsz,
        nodes: std::collections::HashMap::new(),
        heap: std::collections::BinaryHeap::new(),
        seq: 0,
        interesting_queued: 0,
    };
    // 所有起点先挂上各自的标记（get_reference 在 prepare 之前就把 flags 记到对象上）。
    for (id, uninteresting, left) in tips {
        if *uninteresting {
            walk.set_uninteresting(*id);
        }
        if *left {
            walk.nodes.entry(*id).or_default().left = true;
        }
    }
    let mut starts = Vec::new();
    for (id, _, _) in tips {
        walk.parse(*id)?;
        if walk.nodes[id].uninteresting {
            walk.mark_parents_uninteresting(*id);
        }
        let node = walk.nodes.get_mut(id).expect("parsed above");
        if !node.seen {
            node.seen = true;
            starts.push((*id, node.date));
        }
    }
    // commit_list_sort_by_date 是稳定排序。
    starts.sort_by_key(|start| std::cmp::Reverse(start.1));
    for (id, _) in starts {
        walk.queue(id);
    }

    let mut slop = SLOP;
    let mut date = u64::MAX;
    let mut newlist = Vec::new();
    while let Some(id) = walk.pop() {
        walk.process_parents(id)?;
        if walk.nodes[&id].uninteresting {
            walk.mark_parents_uninteresting(id);
            // still_interesting
            slop = match walk.heap.peek() {
                None => 0,
                Some(&(head, _, _)) if date <= head => SLOP,
                Some(_) if walk.interesting_queued > 0 => SLOP,
                Some(_) => slop - 1,
            };
            if slop > 0 {
                continue;
            }
            break;
        }
        date = walk.nodes[&id].date;
        newlist.push(id);
    }
    // get_commit_action：输出时仍会跳过后来才被标记为 UNINTERESTING 的提交。
    Ok(newlist.into_iter().filter(|id| !walk.nodes[id].uninteresting).map(|id| (id, walk.nodes[&id].left)).collect())
}

/// log-tree.c `format_decorations`：`%D` 用空前后缀，HEAD 指向的分支并入 `HEAD -> ` 之后。
fn format_decorations(id: gix::ObjectId, decorations: &Decorations) -> Vec<u8> {
    let Some(list) = decorations.by_commit.get(&id) else { return Vec::new() };
    let current = match &decorations.head {
        HeadState::Symbolic { branch, .. }
            if branch.starts_with(b"refs/") && list.iter().any(|d| d.kind == DecorationKind::Head) =>
        {
            list.iter().position(|d| d.kind == DecorationKind::Local && d.name == *branch)
        }
        _ => None,
    };
    let mut out = Vec::new();
    for (index, decoration) in list.iter().enumerate() {
        if Some(index) == current {
            continue;
        }
        if !out.is_empty() {
            out.extend_from_slice(b", ");
        }
        if decoration.kind == DecorationKind::Tag {
            out.extend_from_slice(b"tag: ");
        }
        out.extend_from_slice(log_format::prettify_refname(&decoration.name));
        if let Some(current) = current
            && decoration.kind == DecorationKind::Head
        {
            out.extend_from_slice(b" -> ");
            out.extend_from_slice(log_format::prettify_refname(&list[current].name));
        }
    }
    out
}

/// git 的消息格式化规则，逐函数对应 pretty.c、trailer.c、ident.c、commit.c 和 date.c
/// （以 2.54.0 为准）。全部在字节上运算，字符集语义是 git 的 sane ctype：ASCII、
/// 空白只有空格、制表、换行、回车。
pub(crate) mod log_format {
    use gix::ObjectId;

    pub(super) fn is_space(byte: u8) -> bool {
        matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
    }

    fn trim(bytes: &[u8]) -> &[u8] {
        let start = bytes.iter().position(|b| !is_space(*b)).unwrap_or(bytes.len());
        let end = bytes.iter().rposition(|b| !is_space(*b)).map_or(start, |i| i + 1);
        &bytes[start..end.max(start)]
    }

    pub(crate) fn is_utf8_name(name: &str) -> bool {
        name.eq_ignore_ascii_case("utf-8") || name.eq_ignore_ascii_case("utf8")
    }

    /// refs.c `prettify_refname`：只去这三个前缀，别的原样显示。
    pub(super) fn prettify_refname(name: &[u8]) -> &[u8] {
        for prefix in [&b"refs/heads/"[..], b"refs/tags/", b"refs/remotes/"] {
            if let Some(rest) = name.strip_prefix(prefix) {
                return rest;
            }
        }
        name
    }

    pub(crate) struct RawCommit<'a> {
        pub parents: Vec<ObjectId>,
        /// commit.c `parse_commit_date`：排序用的提交时间，解析不出来按 0 算。
        pub date: u64,
        pub author: &'a [u8],
        pub committer: &'a [u8],
        pub has_encoding_header: bool,
        /// 头部之后的内容，从分隔头部与正文的那个换行开始（pretty.c `message_off`）。
        pub message: &'a [u8],
    }

    /// commit.c `parse_commit_buffer` 加 pretty.c `parse_commit_header`。
    pub(crate) fn parse_commit(data: &[u8], hexsz: usize) -> Result<RawCommit<'_>, String> {
        if data.contains(&0) {
            return Err("commit object contains NUL".into());
        }
        let tree_entry_len = hexsz + 5;
        let parent_entry_len = hexsz + 7;
        if data.len() <= tree_entry_len + 1 || !data.starts_with(b"tree ") || data[tree_entry_len] != b'\n' {
            return Err("bogus commit object".into());
        }
        let mut pos = tree_entry_len + 1;
        let mut parents = Vec::new();
        while pos + parent_entry_len < data.len() && data[pos..].starts_with(b"parent ") {
            if data.len() <= pos + parent_entry_len + 1 || data[pos + parent_entry_len] != b'\n' {
                return Err("bad parents in commit".into());
            }
            let parent = ObjectId::from_hex(&data[pos + 7..pos + parent_entry_len]).map_err(|e| e.to_string())?;
            parents.push(parent);
            pos += parent_entry_len + 1;
        }
        let date = parse_commit_date(&data[pos..])?;

        let mut author = None;
        let mut committer = None;
        let mut has_encoding_header = false;
        let mut i = 0;
        let message_off = loop {
            if i >= data.len() {
                break data.len();
            }
            let eol = data[i..].iter().position(|b| *b == b'\n').map_or(data.len(), |n| i + n);
            if i == eol {
                break i;
            }
            let line = &data[i..eol];
            if let Some(rest) = line.strip_prefix(b"author ") {
                author = Some(rest);
            } else if let Some(rest) = line.strip_prefix(b"committer ") {
                committer = Some(rest);
            } else if line.starts_with(b"encoding ") {
                has_encoding_header = true;
            }
            i = eol + 1;
        };
        Ok(RawCommit {
            parents,
            date,
            author: author.ok_or("commit without author header")?,
            committer: committer.ok_or("commit without committer header")?,
            has_encoding_header,
            message: &data[message_off..],
        })
    }

    /// commit.c `parse_commit_date`，`buf` 从 parent 行之后开始。
    fn parse_commit_date(buf: &[u8]) -> Result<u64, String> {
        if buf.len() <= 6 || !buf.starts_with(b"author") {
            return Ok(0);
        }
        let Some(newline) = buf.iter().position(|b| *b == b'\n') else { return Ok(0) };
        let buf = &buf[newline + 1..];
        if buf.len() <= 9 || !buf.starts_with(b"committer") {
            return Ok(0);
        }
        let Some(eol) = buf.iter().position(|b| *b == b'\n') else { return Ok(0) };
        let Some(gt) = buf[..eol].iter().rposition(|b| *b == b'>') else { return Ok(0) };
        let mut dateptr = gt + 1;
        while dateptr < eol && is_space(buf[dateptr]) {
            dateptr += 1;
        }
        if dateptr >= eol || buf[dateptr] == b'-' {
            // git 会把 "-" 交给 strtoumax 回绕成极大值；这种损坏提交不走快速路径。
            return if dateptr < eol { Err("negative committer timestamp".into()) } else { Ok(0) };
        }
        if !buf[dateptr].is_ascii_digit() {
            return Ok(0);
        }
        parse_timestamp(&buf[dateptr..eol])
    }

    /// strtoumax 的十进制部分：读到第一个非数字为止，溢出时不走快速路径。
    fn parse_timestamp(bytes: &[u8]) -> Result<u64, String> {
        let mut value: u64 = 0;
        for byte in bytes.iter().take_while(|b| b.is_ascii_digit()) {
            value = value
                .checked_mul(10)
                .and_then(|v| v.checked_add(u64::from(byte - b'0')))
                .ok_or("timestamp overflows u64")?;
        }
        Ok(value)
    }

    /// pretty.c `get_one_line`：行长度含换行，末尾没有换行时到结尾为止。
    fn one_line(msg: &[u8]) -> usize {
        msg.iter().position(|b| *b == b'\n').map_or(msg.len(), |n| n + 1)
    }

    /// pretty.c `is_blank_line`：去掉结尾空白后剩下的长度，为 0 即空行。
    fn trimmed_len(line: &[u8]) -> usize {
        line.iter().rposition(|b| !is_space(*b)).map_or(0, |i| i + 1)
    }

    /// pretty.c `skip_blank_lines`，返回跳过的字节数。
    fn skip_blank_lines(msg: &[u8]) -> usize {
        let mut offset = 0;
        loop {
            let len = one_line(&msg[offset..]);
            if len == 0 || trimmed_len(&msg[offset..offset + len]) != 0 {
                return offset;
            }
            offset += len;
        }
    }

    /// pretty.c `parse_commit_message`：正文从头部后的第一个非空行开始。
    pub(super) struct Message<'a> {
        from_subject: &'a [u8],
        body_off: usize,
    }

    impl<'a> Message<'a> {
        pub fn new(after_header: &'a [u8]) -> Self {
            let from_subject = &after_header[skip_blank_lines(after_header)..];
            let paragraph_end = subject_paragraph(from_subject, None);
            let body_off = paragraph_end + skip_blank_lines(&from_subject[paragraph_end..]);
            Message { from_subject, body_off }
        }

        /// `%(trailers)` 和 `%s` 都从这里开始。
        pub fn starting_at_subject(&self) -> &'a [u8] {
            self.from_subject
        }

        /// `%s`：标题段各行去掉结尾空白，用空格连接。
        pub fn subject(&self) -> Vec<u8> {
            let mut out = Vec::new();
            subject_paragraph(self.from_subject, Some(&mut out));
            out
        }

        /// `%b`：标题段之后、跳过空行，直到结尾原样输出。
        pub fn body(&self) -> &'a [u8] {
            &self.from_subject[self.body_off..]
        }
    }

    /// pretty.c `format_subject`，返回标题段（含终止它的空行）占的字节数。
    fn subject_paragraph(msg: &[u8], mut out: Option<&mut Vec<u8>>) -> usize {
        let mut offset = 0;
        let mut first = true;
        loop {
            let len = one_line(&msg[offset..]);
            let line = &msg[offset..offset + len];
            offset += len;
            let trimmed = trimmed_len(line);
            if len == 0 || trimmed == 0 {
                return offset;
            }
            if let Some(out) = out.as_deref_mut() {
                if !first {
                    out.push(b' ');
                }
                out.extend_from_slice(&line[..trimmed]);
                first = false;
            }
        }
    }

    /// ident.c `split_ident_line` 加 pretty.c `format_person_part`、date.c `DATE_RAW`：
    /// `name <mail> epoch ±HHMM`。拆不开（git 会原样打印占位符）时返回 `None`。
    pub(super) fn format_person(line: &[u8]) -> Option<Vec<u8>> {
        let lt = line.iter().position(|b| *b == b'<')?;
        let name_end = line[..lt].iter().rposition(|b| !is_space(*b)).map_or(0, |i| i + 1);
        let mail_begin = lt + 1;
        let mail_end = mail_begin + line[mail_begin..].iter().position(|b| *b == b'>')?;
        let last_gt = line.iter().rposition(|b| *b == b'>')?;
        let mut cp = last_gt + 1;
        while cp < line.len() && is_space(line[cp]) {
            cp += 1;
        }
        let date_begin = cp;
        let date_end = date_begin + line[date_begin..].iter().take_while(|b| b.is_ascii_digit()).count();
        if date_end == date_begin {
            return None;
        }
        cp = date_end;
        while cp < line.len() && is_space(line[cp]) {
            cp += 1;
        }
        if cp >= line.len() || !matches!(line[cp], b'+' | b'-') {
            return None;
        }
        let tz_begin = cp;
        let tz_end = tz_begin + 1 + line[tz_begin + 1..].iter().take_while(|b| b.is_ascii_digit()).count();
        if tz_end == tz_begin + 1 {
            return None;
        }
        let date = parse_timestamp(&line[date_begin..date_end]).ok()?;
        if date > i64::MAX as u64 {
            return None;
        }
        let tz = std::str::from_utf8(&line[tz_begin..tz_end]).ok()?.parse::<i64>().ok()?;
        let tz = if tz >= i64::from(i32::MAX) || tz <= i64::from(i32::MIN) { 0 } else { tz };
        let mut out = line[..name_end].to_vec();
        out.extend_from_slice(b" <");
        out.extend_from_slice(&line[mail_begin..mail_end]);
        out.extend_from_slice(b"> ");
        out.extend_from_slice(format!("{date} {tz:+05}").as_bytes());
        Some(out)
    }

    /// trailer.c `find_separator`，分隔符只有默认的 `:`。
    fn find_separator(line: &[u8]) -> Option<usize> {
        let mut whitespace_found = false;
        for (i, byte) in line.iter().copied().enumerate() {
            if byte == b':' {
                return Some(i);
            }
            if !whitespace_found && (byte.is_ascii_alphanumeric() || byte == b'-') {
                continue;
            }
            if i != 0 && matches!(byte, b' ' | b'\t') {
                whitespace_found = true;
                continue;
            }
            break;
        }
        None
    }

    /// trailer.c `is_blank_line`。
    fn is_blank(line: &[u8]) -> bool {
        line.iter().take_while(|b| **b != b'\n').all(|b| is_space(*b))
    }

    /// trailer.c `next_line`：下一行的起点，没有换行时到结尾。
    fn next_line(buf: &[u8], pos: usize) -> usize {
        buf[pos..].iter().position(|b| *b == b'\n').map_or(buf.len(), |n| pos + n + 1)
    }

    /// trailer.c `last_line`：`len` 之前最后一行的起点。
    fn last_line(buf: &[u8], len: usize) -> Option<usize> {
        match len {
            0 => None,
            1 => Some(0),
            _ => Some((0..=len - 2).rev().find(|i| buf[*i] == b'\n').map_or(0, |i| i + 1)),
        }
    }

    /// wt-status.c `wt_status_locate_end` 加 commit.c `ignored_log_message_bytes`：
    /// 剪刀线之后、结尾的注释行、空行和旧式 `Conflicts:` 块都不算消息。
    fn end_of_log_message(input: &[u8]) -> usize {
        let len = input.len();
        let pattern: &[u8] = b"\n# ------------------------ >8 ------------------------\n";
        let mut cutoff = len;
        if input.starts_with(&pattern[1..]) {
            cutoff = 0;
        } else if let Some(p) = input.windows(pattern.len()).position(|window| window == pattern) {
            cutoff = cutoff.min(p + 1);
        }
        // git 用 0 表示「还没遇到结尾注释」，从偏移 0 开始的注释段因此不算——照搬。
        let mut boc = 0;
        let mut bol = 0;
        let mut in_old_conflicts_block = false;
        while bol < cutoff {
            let next = next_line(input, bol);
            if input[bol] == b'#' || input[bol] == b'\n' {
                if boc == 0 {
                    boc = bol;
                }
            } else if input[bol..].starts_with(b"Conflicts:\n") {
                in_old_conflicts_block = true;
                if boc == 0 {
                    boc = bol;
                }
            } else if in_old_conflicts_block && input[bol] == b'\t' {
            } else if boc != 0 {
                boc = 0;
                in_old_conflicts_block = false;
            }
            bol = next;
        }
        if boc != 0 { boc } else { cutoff }
    }

    /// trailer.c `find_trailer_block_start`：从末尾往前找空行，其后的段落要么全是
    /// trailer，要么含 git 自己生成的 trailer 且 trailer 行不少于四分之一。
    fn trailer_block_start(buf: &[u8]) -> usize {
        let len = buf.len();
        let mut s = 0;
        while s < len {
            if buf[s] != b'#' && is_blank(&buf[s..]) {
                break;
            }
            s = next_line(buf, s);
        }
        let end_of_title = s;

        let mut only_spaces = true;
        let mut recognized_prefix = false;
        let (mut trailer_lines, mut non_trailer_lines, mut possible_continuation_lines) = (0i64, 0i64, 0i64);
        let mut l = last_line(buf, len);
        while let Some(line) = l {
            if line < end_of_title {
                break;
            }
            l = last_line(buf, line);
            let bol = &buf[line..];
            if bol[0] == b'#' {
                non_trailer_lines += possible_continuation_lines;
                possible_continuation_lines = 0;
                continue;
            }
            if is_blank(bol) {
                if only_spaces {
                    continue;
                }
                non_trailer_lines += possible_continuation_lines;
                if (recognized_prefix && trailer_lines * 3 >= non_trailer_lines)
                    || (trailer_lines > 0 && non_trailer_lines == 0)
                {
                    return next_line(buf, line);
                }
                return len;
            }
            only_spaces = false;
            if bol.starts_with(b"Signed-off-by: ") || bol.starts_with(b"(cherry picked from commit ") {
                trailer_lines += 1;
                possible_continuation_lines = 0;
                recognized_prefix = true;
                continue;
            }
            if find_separator(bol).is_some_and(|pos| pos >= 1) && !is_space(bol[0]) {
                trailer_lines += 1;
                possible_continuation_lines = 0;
            } else if is_space(bol[0]) {
                possible_continuation_lines += 1;
            } else {
                non_trailer_lines += 1;
                non_trailer_lines += possible_continuation_lines;
                possible_continuation_lines = 0;
            }
        }
        len
    }

    /// trailer.c `unfold_value`：续行折成一个空格，再去两端空白。
    fn unfold(value: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(value.len());
        let mut i = 0;
        while i < value.len() {
            let c = value[i];
            i += 1;
            if c == b'\n' {
                while i < value.len() && is_space(value[i]) {
                    i += 1;
                }
                out.push(b' ');
            } else {
                out.push(c);
            }
        }
        trim(&out).to_vec()
    }

    /// `%(trailers:unfold,only)`：trailer.c `format_trailers_from_commit` 走
    /// `parse_trailers` + `format_trailers` 的分支（因为带选项）。
    pub(super) fn trailers_only_unfold(msg: &[u8]) -> Vec<u8> {
        let end = end_of_log_message(msg);
        let start = trailer_block_start(&msg[..end]);
        // strbuf_split_buf 保留换行；续行（以空白开头）并入上一条 trailer。
        let mut strings: Vec<Vec<u8>> = Vec::new();
        let mut last_is_trailer = false;
        let mut pos = start;
        while pos < end {
            let next = next_line(&msg[..end], pos);
            let piece = &msg[pos..next];
            pos = next;
            if last_is_trailer && is_space(piece[0]) {
                strings.last_mut().expect("a trailer precedes continuation").extend_from_slice(piece);
                continue;
            }
            last_is_trailer = find_separator(piece).is_some_and(|sep| sep >= 1);
            strings.push(piece.to_vec());
        }
        let mut out = Vec::new();
        for trailer in &strings {
            if trailer.starts_with(b"#") {
                continue;
            }
            let Some(sep) = find_separator(trailer).filter(|sep| *sep >= 1) else { continue };
            out.extend_from_slice(trim(&trailer[..sep]));
            out.extend_from_slice(b": ");
            out.extend_from_slice(&unfold(trim(&trailer[sep + 1..])));
            out.push(b'\n');
        }
        out
    }
}

/// 两条分支差在哪些提交上。
pub fn compare(root: &Path, ours: &str, theirs: &str, limit: usize) -> Result<Comparison, String> {
    Ok(Comparison {
        ahead: log_range(root, &format!("{theirs}..{ours}"), limit)?,
        behind: log_range(root, &format!("{ours}..{theirs}"), limit)?,
    })
}

/// 某次提交改动的文件列表。
///
/// 照搬 GitHub Desktop 的 `getChangedFiles`（app/src/lib/git/log.ts）：
///
/// ```text
/// git log <sha> -C -M -m -1 --no-show-signature --first-parent \
///         --raw --format=format: --numstat -z --
/// ```
///
/// 为什么走 CLI 而不是 gix 的树对比：
///   - `--raw` 天生只列文件，树对比会连目录自身的变化一起报出来
///   - `-M -C` 给出重命名/复制检测（注意顺序：`-M` 在 `-C` 前会检测不到复制）
///   - `--numstat` 顺带给出每个文件的增删行数
///   - `-z` 用 NUL 分隔，彻底绕开 `core.quotepath` 对非 ASCII 路径的转义
///
/// 点提交是低频操作，起一次 git 进程无所谓；热路径仍然全在 gix 手里。
pub fn commit_files(root: &Path, sha: &str) -> Result<Vec<CommitFile>, String> {
    if let Ok(files) = commit_files_in_process(root, sha) {
        return Ok(files);
    }
    commit_files_via_git(root, sha)
}

pub fn commit_files_via_git(root: &Path, sha: &str) -> Result<Vec<CommitFile>, String> {
    let out = crate::git::Git::new(Some(root))
        .args([
            "log",
            "-C",
            "-M",
            "-m",
            "-1",
            "--no-show-signature",
            "--first-parent",
            "--raw",
            "--format=format:",
            "--numstat",
            "-z",
            "--end-of-options",
            sha,
            "--",
        ])
        .output()?;
    if !out.status.success() {
        return Err(crate::git::stderr_of(&out));
    }
    Ok(parse_raw_with_numstat(&out.stdout))
}

/// `git log -m -1 --first-parent <sha>` 比较的两棵树：第一父的树（根提交为 `None`，即空树）和提交自己的树。
///
/// 只接受完整的对象名或 `HEAD`；浅克隆、`info/grafts`、`refs/replace/*` 会改变父提交或对象本身，让位给 git。
/// `log` 为真时（调用方是 `git log -m`）另外让位：`log.showRoot=false` 让根提交不出 diff，
/// `log.diffMerges` 会改变 `-m` 对合并提交的含义。
pub(crate) fn commit_trees_in_process(
    root: &Path, revision: &str, log: bool,
) -> Result<(gix::Repository, Option<gix::ObjectId>, gix::ObjectId), String> {
    let mut repo = gix::open(root).map_err(|e| e.to_string())?;
    repo.object_cache_size_if_unset(4 * 1024 * 1024);
    repo.objects.refresh_never();
    let id = if revision == "HEAD" {
        repo.head_id().map_err(|e| e.to_string())?.detach()
    } else if revision.len() == repo.object_hash().len_in_hex() {
        gix::ObjectId::from_hex(revision.as_bytes()).map_err(|e| e.to_string())?
    } else {
        return Err("not a full object name".into());
    };
    if repo.is_shallow().map_err(|e| e.to_string())? {
        return Err("shallow repository".into());
    }
    if repo.common_dir().join("info").join("grafts").exists() {
        return Err("info/grafts".into());
    }
    let references = repo.references().map_err(|e| e.to_string())?;
    if references.prefixed("refs/replace/").map_err(|e| e.to_string())?.next().is_some() {
        return Err("refs/replace".into());
    }
    let object = repo.find_object(id).map_err(|e| e.to_string())?;
    if object.kind != gix::object::Kind::Commit {
        return Err("not a commit".into());
    }
    let commit = object.into_commit();
    let parents: Vec<gix::ObjectId> = commit.parent_ids().map(|id| id.detach()).collect();
    let config = repo.config_snapshot();
    if log
        && parents.is_empty()
        && config.boolean("log.showRoot") != Some(true)
        && config.string("log.showRoot").is_some()
    {
        return Err("log.showRoot".into());
    }
    if log && parents.len() > 1 && config.string("log.diffMerges").is_some() {
        return Err("log.diffMerges".into());
    }
    let new_tree = commit.tree_id().map_err(|e| e.to_string())?.detach();
    let old_tree = match parents.first() {
        Some(parent) => {
            Some(repo.find_commit(*parent).map_err(|e| e.to_string())?.tree_id().map_err(|e| e.to_string())?.detach())
        }
        None => None,
    };
    drop((config, commit));
    Ok((repo, old_tree, new_tree))
}

/// `git log -C -M -m -1 --first-parent --raw -z <sha> --` 的进程内实现（diff 队列与重命名检测见 `crate::rename`）。
///
/// raw 段和 numstat 段按 git 的格式拼出来（对象名写完整的，解析时用不到），再交给 `parse_raw_with_numstat`，
/// 和 git 那一路共用同一个解析器。`-C -M` 实际只做重命名（`-M` 在后，把检测模式改回 `DIFF_DETECT_RENAME`），
/// 目标是新增、来源是删除；子模块、`commit_trees_in_process` 让位的情形，重命名检测无法证明一致的情形
/// （见 `rename::commit_pairs`），以及 numstat 算不出和 git 相同数字的情形（xdiff 设置、`diff.orderFile`、
/// 路径带 diff 属性、文件超过 16 MiB）交给 git。`Err` 只表示「不走快速路径」。
pub(crate) fn commit_files_in_process(root: &Path, sha: &str) -> Result<Vec<CommitFile>, String> {
    Ok(parse_raw_with_numstat(&crate::rename::commit_log_bytes(root, sha, false)?))
}

/// 解析 `--raw -z` 与 `--numstat -z` 混在一起的输出。
///
/// raw 记录以 `:` 开头，字段用空格分隔，状态码后跟 NUL，再跟路径：
/// ```text
/// :100644 100644 <src> <dst> M\0path\0
/// :100644 100644 <src> <dst> R100\0old\0new\0
/// ```
/// numstat 记录形如 `added\tdeleted\tpath\0`，重命名/复制时路径分成两段：`added\tdeleted\t\0old\0new\0`；
/// 二进制文件两个数都是 `-`。raw 段给状态与路径，numstat 段按（新）路径配上增删行数。
pub fn parse_raw_with_numstat(stdout: &[u8]) -> Vec<CommitFile> {
    let mut out: Vec<CommitFile> = Vec::new();
    let mut counts: Vec<(String, Option<u64>, Option<u64>)> = Vec::new();
    let mut it = stdout.split(|b| *b == 0).peekable();

    while let Some(field) = it.next() {
        if field.is_empty() {
            continue;
        }
        if field[0] != b':' {
            // numstat 段：`added\tdeleted\tpath` 或 `added\tdeleted\t` + 两段路径
            let mut parts = field.splitn(3, |b| *b == b'\t');
            let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
                continue;
            };
            let count = |text: &[u8]| (text != b"-").then(|| String::from_utf8_lossy(text).parse::<u64>().unwrap_or(0));
            let path = if path.is_empty() {
                it.next();
                it.next().map(|new_path| String::from_utf8_lossy(new_path).into_owned())
            } else {
                Some(String::from_utf8_lossy(path).into_owned())
            };
            if let Some(path) = path {
                counts.push((path, count(added), count(deleted)));
            }
            continue;
        }
        // ":<srcmode> <dstmode> <srcsha> <dstsha> <status>"
        let text = String::from_utf8_lossy(field);
        let Some(status) = text.split(' ').next_back() else {
            continue;
        };
        let code = status.chars().next().unwrap_or('M');

        let Some(path) = it.next() else { break };
        let path = String::from_utf8_lossy(path).into_owned();

        let kind = match code {
            'A' => CommitFileKind::Added,
            'D' => CommitFileKind::Deleted,
            'R' => CommitFileKind::Renamed,
            'C' => CommitFileKind::Copied,
            _ => CommitFileKind::Modified,
        };

        let old_path = matches!(code, 'R' | 'C').then(|| path.clone());
        let rename_includes_modifications = code == 'R' && status != "R100";
        let submodule = text.starts_with(":160000 ") || text.split(' ').nth(1) == Some("160000");
        // 重命名/复制还带一个目标路径，显示用新路径
        let path = if matches!(code, 'R' | 'C') {
            match it.next() {
                Some(new_path) => String::from_utf8_lossy(new_path).into_owned(),
                None => path,
            }
        } else {
            path
        };

        out.push(CommitFile {
            path,
            kind,
            old_path,
            rename_includes_modifications,
            submodule,
            lines_added: None,
            lines_deleted: None,
        });
    }

    for (path, lines_added, lines_deleted) in counts {
        if let Some(file) = out.iter_mut().find(|file| file.path == path) {
            file.lines_added = lines_added;
            file.lines_deleted = lines_deleted;
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changeset {
    pub files: Vec<CommitFile>,
    pub lines_added: u64,
    pub lines_deleted: u64,
    pub commitish: String,
    pub parent_commitish: String,
}

pub fn merge_base_changes(repo: &Path, from: &str, to: &str, latest: &str) -> Result<Option<Changeset>, String> {
    let Some(base) = crate::ops::merge_base(repo, from, to)? else {
        return Ok(None);
    };
    let output = crate::git::Git::new(Some(repo))
        .args([
            "diff",
            "--merge-base",
            "-C",
            "-M",
            "-z",
            "--raw",
            "--numstat",
            "--no-ext-diff",
            "--end-of-options",
            from,
            to,
            "--",
        ])
        .output()?;
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    let mut lines_added = 0;
    let mut lines_deleted = 0;
    let mut fields = output.stdout.split(|b| *b == 0);
    while let Some(field) = fields.next() {
        if field.starts_with(b":") {
            let rename = field
                .split(|b| *b == b' ')
                .next_back()
                .is_some_and(|status| status.starts_with(b"R") || status.starts_with(b"C"));
            fields.next();
            if rename {
                fields.next();
            }
        } else {
            let mut parts = field.splitn(3, |b| *b == b'\t');
            if let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next()) {
                lines_added += String::from_utf8_lossy(added).parse::<u64>().unwrap_or(0);
                lines_deleted += String::from_utf8_lossy(deleted).parse::<u64>().unwrap_or(0);
                if path.is_empty() {
                    fields.next();
                    fields.next();
                }
            }
        }
    }
    Ok(Some(Changeset {
        files: parse_raw_with_numstat(&output.stdout),
        lines_added,
        lines_deleted,
        commitish: latest.into(),
        parent_commitish: base,
    }))
}

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct CommitOneLine {
    pub sha: String,
    pub summary: String,
}

pub fn commits_in_range(repo: &Path, range: &str) -> Result<Option<Vec<CommitOneLine>>, String> {
    let output = crate::git::Git::new(Some(repo))
        .args(["rev-list", "--reverse", "--oneline", "--no-abbrev-commit", "--end-of-options", range, "--"])
        .output()?;
    if output.status.code() == Some(128) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    Ok(Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let (sha, summary) = line.split_once(' ')?;
                Some(CommitOneLine { sha: sha.into(), summary: summary.into() })
            })
            .collect(),
    ))
}

pub fn has_merges_after(repo: &Path, revision: Option<&str>) -> Result<bool, String> {
    let range = revision.map(|revision| format!("{revision}..HEAD")).unwrap_or_else(|| "HEAD".into());
    let output = crate::git::Git::new(Some(repo))
        .args(["rev-list", "-1", "--merges", "--end-of-options", &range, "--"])
        .output()?;
    if !matches!(output.status.code(), Some(0 | 128)) {
        return Err(crate::git::stderr_of(&output));
    }
    Ok(!output.stdout.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn 标签缓存跟着引用变化失效() {
        let (_directory, root) = repo();
        let git = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        assert!(log(&root, 1, 0).unwrap()[0].tags.is_empty());
        git(&["tag", "v1"]);
        assert_eq!(log(&root, 1, 0).unwrap()[0].tags, vec!["v1".to_string()], "新建的松散标签要立刻看到");
        git(&["tag", "-a", "-m", "annotated", "v2"]);
        git(&["pack-refs", "--all"]);
        assert_eq!(
            log(&root, 1, 0).unwrap()[0].tags,
            vec!["v2".to_string(), "v1".to_string()],
            "打包后的注释标签照样 peel"
        );
        git(&["tag", "-d", "v1"]);
        assert_eq!(log(&root, 1, 0).unwrap()[0].tags, vec!["v2".to_string()], "删除标签后缓存失效");
    }

    #[test]
    fn detailed_history_keeps_committer_trailers_and_control_bytes() {
        let (_directory, root) = repo();
        let result = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args([
                "commit",
                "--allow-empty",
                "-m",
                "Subject\n\nBody\u{1}continues\n\nCo-authored-by: Other <other@example.test>",
            ])
            .env("GIT_AUTHOR_NAME", "Author")
            .env("GIT_AUTHOR_EMAIL", "author@example.test")
            .env("GIT_COMMITTER_NAME", "Committer")
            .env("GIT_COMMITTER_EMAIL", "committer@example.test")
            .output()
            .unwrap();
        assert!(result.status.success());
        let commits = query_details(&root, Some("HEAD"), Some(1), None, &[]).unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].summary, "Subject");
        assert!(commits[0].body.contains("Body\u{1}continues"));
        assert!(commits[0].author.starts_with("Author <author@example.test> "));
        assert!(commits[0].committer.starts_with("Committer <committer@example.test> "));
        assert!(commits[0].trailers.contains("Co-authored-by: Other <other@example.test>"));
    }

    /// 测试里故意直接调 git，不走 crate::git 的封装——
    /// 那是被测对象，用它验自己等于没验。
    fn git(r: &Path, args: &[&str]) -> String {
        let o = Command::new("git").arg("-C").arg(r).args(args).output().unwrap();
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    /// 固定作者、提交时间的 git 调用，失败即 panic。时间相同的提交考验的是排序。
    fn git_at(r: &Path, date: &str, args: &[&str]) -> String {
        let o = Command::new("git")
            .arg("-C")
            .arg(r)
            .args(args)
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    /// 原样提交一条消息（不让 git 清理空白、注释），正文字节由夹具完全控制。
    fn commit_verbatim(r: &Path, date: &str, message: &str) {
        let file = r.join(".git").join("MESSAGE");
        std::fs::write(&file, message).unwrap();
        git_at(r, date, &["commit", "-q", "--allow-empty", "--cleanup=verbatim", "-F", file.to_str().unwrap()]);
    }

    fn bare_repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "测试者"]);
        (d, r)
    }

    /// 快速路径必须可用，且每个提交的九个字段都与 git 命令逐字相同。
    fn assert_fast_path_matches(root: &Path, limit: Option<usize>, skip: Option<usize>) -> Vec<CommitDetails> {
        let fast = details_via_gix(root, None, limit, skip, &[])
            .unwrap_or_else(|reason| panic!("fast path refused (limit {limit:?}, skip {skip:?}): {reason}"));
        let slow = details_via_git(root, None, limit, skip, &[]).unwrap();
        assert_eq!(fast.len(), slow.len(), "commit count (limit {limit:?}, skip {skip:?})");
        for (index, (ours, theirs)) in fast.iter().zip(&slow).enumerate() {
            assert_eq!(ours, theirs, "commit #{index} (limit {limit:?}, skip {skip:?})");
        }
        assert_eq!(query_details(root, None, limit, skip, &[]).unwrap(), slow);
        fast
    }

    /// 全量加几种翻页都要一致。
    fn assert_history_matches(root: &Path) -> Vec<CommitDetails> {
        let all = assert_fast_path_matches(root, None, None);
        assert_fast_path_matches(root, Some(1), None);
        assert_fast_path_matches(root, Some(2), Some(1));
        assert_fast_path_matches(root, Some(100), Some(all.len().saturating_sub(2)));
        assert_fast_path_matches(root, Some(3), Some(all.len() + 5));
        all
    }

    thread_local! {
        pub(super) static FULL_SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    /// Everything `Decorations` exposes, in a stable order.
    fn decorations_snapshot(decorations: &Decorations) -> String {
        let mut by_commit: Vec<_> = decorations
            .by_commit
            .iter()
            .map(|(id, list)| {
                let list: Vec<_> =
                    list.iter().map(|d| format!("{:?} {}", d.kind, String::from_utf8_lossy(&d.name))).collect();
                (id.to_string(), list)
            })
            .collect();
        by_commit.sort();
        let mut tags: Vec<_> = decorations.tags_by_commit.iter().collect();
        tags.sort();
        format!(
            "{by_commit:?}\n{tags:?}\n{:?}\n{:?}\nreplace {}",
            decorations.tip_order, decorations.head, decorations.has_replace
        )
    }

    /// The cached index equals a fresh scan; returns whether answering it needed a full scan.
    fn assert_index_fresh(r: &Path, label: &str) -> bool {
        let repo = gix::open(r).unwrap();
        let before = FULL_SCANS.with(std::cell::Cell::get);
        let cached = decorations(&repo).unwrap();
        let scanned = FULL_SCANS.with(std::cell::Cell::get) != before;
        assert_eq!(decorations_snapshot(&cached), decorations_snapshot(&build_decorations(&repo).unwrap()), "{label}");
        scanned
    }

    /// Ages every file under `.git/refs`, `packed-refs` and `HEAD` past the racy window.
    fn age_refs(r: &Path) {
        fn age(path: &Path) {
            let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
            if path.is_dir() {
                for entry in std::fs::read_dir(path).unwrap() {
                    age(&entry.unwrap().path());
                }
            } else if path.exists() {
                std::fs::File::options().write(true).open(path).unwrap().set_modified(old).unwrap();
            }
        }
        for path in ["refs", "packed-refs", "HEAD"] {
            age(&r.join(".git").join(path));
        }
    }

    /// After a ref change only the changed loose files are re-read; the result must equal a full scan in
    /// every case, and anything the incremental path cannot vouch for (packed-refs, broken refs) rescans.
    #[test]
    fn ref_index_updates_incrementally_and_matches_a_full_scan() {
        let (_d, r) = bare_repo();
        let date = "1700000000 +0100";
        std::fs::write(r.join("a"), "a\n").unwrap();
        git_at(&r, date, &["add", "a"]);
        git_at(&r, date, &["commit", "-qm", "first"]);
        git_at(&r, date, &["tag", "light"]);
        git_at(&r, date, &["tag", "-a", "-m", "msg", "annotated"]);
        git_at(&r, date, &["branch", "a/x"]);
        git_at(&r, date, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git_at(&r, date, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        git_at(&r, date, &["symbolic-ref", "refs/remotes/origin/later", "refs/remotes/origin/not-yet"]);
        age_refs(&r);
        assert!(assert_index_fresh(&r, "first read"));
        assert!(!assert_index_fresh(&r, "unchanged"));

        git_at(&r, "1700000001 +0100", &["commit", "-q", "--allow-empty", "-m", "second"]);
        assert!(!assert_index_fresh(&r, "commit"));
        git_at(&r, date, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        assert!(!assert_index_fresh(&r, "symbolic target moved"));
        git_at(&r, date, &["update-ref", "refs/remotes/origin/not-yet", "HEAD~1"]);
        assert!(!assert_index_fresh(&r, "dangling symbolic ref resolves"));
        git_at(&r, date, &["tag", "-d", "light"]);
        git_at(&r, date, &["tag", "-a", "-m", "msg", "new-annotated", "HEAD~1"]);
        assert!(!assert_index_fresh(&r, "tags"));
        git_at(&r, date, &["branch", "-D", "a/x"]);
        assert!(!assert_index_fresh(&r, "branch and its directory removed"));
        git_at(&r, date, &["checkout", "-q", "--detach", "HEAD~1"]);
        assert!(!assert_index_fresh(&r, "HEAD detached"));
        git_at(&r, date, &["checkout", "-q", "main"]);
        assert!(!assert_index_fresh(&r, "HEAD back"));
        assert_history_matches(&r);

        // In-place rewrite with the size, inode and mtime unchanged: stat cannot see it, so only the racy
        // re-read catches it while the file is recent.
        let main = r.join(".git/refs/heads/main");
        let modified = std::fs::metadata(&main).unwrap().modified().unwrap();
        let first = git(&r, &["rev-parse", "HEAD~1"]);
        std::fs::write(&main, &first).unwrap();
        std::fs::File::options().write(true).open(&main).unwrap().set_modified(modified).unwrap();
        assert!(!assert_index_fresh(&r, "racy in-place rewrite"));
        assert_history_matches(&r);

        git_at(&r, date, &["pack-refs", "--all"]);
        assert!(assert_index_fresh(&r, "pack-refs rescans"));
        // A recent packed-refs stays racy, so the next change rescans too; age it first.
        age_refs(&r);
        assert!(assert_index_fresh(&r, "packed-refs touched"));
        let other = git_at(&r, date, &["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "other"]);
        git_at(&r, date, &["update-ref", "refs/heads/main", other.trim()]);
        assert!(!assert_index_fresh(&r, "loose over packed"));
        std::fs::remove_file(&main).unwrap();
        assert!(!assert_index_fresh(&r, "loose removed, packed value again"));
        git_at(&r, date, &["update-ref", "refs/replace/0000000000000000000000000000000000000001", "HEAD"]);
        assert!(!assert_index_fresh(&r, "replace ref"));
        git_at(&r, date, &["update-ref", "-d", "refs/replace/0000000000000000000000000000000000000001"]);
        assert!(!assert_index_fresh(&r, "replace ref removed"));
        std::fs::write(r.join(".git/refs/heads/broken"), "not a ref\n").unwrap();
        assert!(assert_index_fresh(&r, "broken ref rescans"));
        std::fs::remove_file(r.join(".git/refs/heads/broken")).unwrap();
        assert!(!assert_index_fresh(&r, "broken ref removed"));
        assert_history_matches(&r);
    }

    #[test]
    fn decorations_match_git_across_namespaces_and_packing() {
        let (_d, r) = bare_repo();
        std::fs::write(r.join("a"), "a\n").unwrap();
        git_at(&r, "1700000000 +0100", &["add", "a"]);
        git_at(&r, "1700000000 +0100", &["commit", "-qm", "first"]);
        git_at(&r, "1700000000 +0100", &["tag", "v1"]);
        git_at(&r, "1700000000 +0100", &["tag", "-a", "-m", "msg", "v0.9"]);
        git_at(&r, "1700000000 +0100", &["tag", "-a", "-m", "msg", "zeta"]);
        git_at(&r, "1700000000 +0100", &["tag", "Alpha"]);
        git_at(&r, "1700000000 +0100", &["tag", "with,comma"]);
        // 嵌套标签：标签指向标签，git 一路剥到提交
        git_at(&r, "1700000000 +0100", &["tag", "-a", "-m", "nested", "nested", "v0.9"]);
        for branch in ["feature", "a-b", "a/x", "a0"] {
            git_at(&r, "1700000000 +0100", &["branch", branch]);
        }
        git_at(&r, "1700000000 +0100", &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git_at(&r, "1700000000 +0100", &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        for other in ["refs/pull/1/head", "refs/notes/commits", "refs/stash", "refs/foo/bar"] {
            git_at(&r, "1700000000 +0100", &["update-ref", other, "HEAD"]);
        }
        // 悬空引用：git 的遍历会跳过它
        std::fs::write(r.join(".git/refs/heads/dangling"), "0123456789abcdef0123456789abcdef01234567\n").unwrap();
        let details = assert_history_matches(&r);
        assert_eq!(
            details[0].refs,
            "HEAD -> main, tag: zeta, tag: with,comma, tag: v1, tag: v0.9, tag: nested, tag: Alpha, refs/stash, \
             origin/main, origin/HEAD, feature, a0, a/x, a-b"
        );
        git_at(&r, "1700000000 +0100", &["pack-refs", "--all"]);
        assert_eq!(assert_history_matches(&r)[0].refs, details[0].refs, "packed refs decorate the same way");
        git_at(&r, "1700000000 +0100", &["tag", "-d", "v1"]);
        git_at(&r, "1700000000 +0100", &["branch", "-D", "a0"]);
        assert!(!assert_history_matches(&r)[0].refs.contains("v1"), "deleted refs leave the cached index");
    }

    #[test]
    fn detached_head_matches_git() {
        let (_d, r) = bare_repo();
        commit_verbatim(&r, "1700000000 +0000", "first\n");
        commit_verbatim(&r, "1700000001 +0000", "second\n");
        git_at(&r, "1700000001 +0000", &["tag", "-a", "-m", "annotated", "t1"]);
        git_at(&r, "1700000001 +0000", &["checkout", "-q", "--detach"]);
        let details = assert_history_matches(&r);
        assert_eq!(details[0].refs, "HEAD, tag: t1, main");
        git_at(&r, "1700000001 +0000", &["checkout", "-q", "HEAD~1"]);
        assert_eq!(assert_history_matches(&r)[0].refs, "HEAD");
        // HEAD 直接指向标签对象（git 会剥到提交，装饰显示为 tag: HEAD）
        let tag_object = git_at(&r, "1700000001 +0000", &["rev-parse", "t1"]);
        std::fs::write(r.join(".git/HEAD"), format!("{}\n", tag_object.trim())).unwrap();
        assert_eq!(assert_history_matches(&r)[0].refs, "tag: HEAD, tag: t1, main");
    }

    #[test]
    fn symbolic_head_outside_heads_and_current_branch_elision() {
        let (_d, r) = bare_repo();
        commit_verbatim(&r, "1700000000 +0000", "first\n");
        git_at(&r, "1700000000 +0000", &["branch", "other"]);
        assert_eq!(assert_history_matches(&r)[0].refs, "HEAD -> main, other");
        git_at(&r, "1700000000 +0000", &["switch", "-q", "other"]);
        assert_eq!(assert_history_matches(&r)[0].refs, "HEAD -> other, main");
        // HEAD 指向 refs/heads 之外的引用：没有可并入的分支，HEAD 单独显示
        git_at(&r, "1700000000 +0000", &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git_at(&r, "1700000000 +0000", &["symbolic-ref", "HEAD", "refs/remotes/origin/main"]);
        assert_eq!(assert_history_matches(&r)[0].refs, "HEAD, origin/main, other, main");
    }

    #[test]
    fn merges_and_identical_timestamps_order_like_git() {
        let (_d, r) = bare_repo();
        let same = "1700000000 +0000";
        commit_verbatim(&r, same, "root\n");
        for branch in ["b1", "b2", "b3"] {
            git_at(&r, same, &["switch", "-qc", branch, "main"]);
            commit_verbatim(&r, same, &format!("{branch} first\n"));
            commit_verbatim(&r, same, &format!("{branch} second\n"));
        }
        git_at(&r, same, &["switch", "-q", "main"]);
        commit_verbatim(&r, same, "main side\n");
        git_at(&r, same, &["merge", "-q", "--no-ff", "-m", "octopus", "b1", "b2", "b3"]);
        // 时间倒着走的提交：父比子新
        commit_verbatim(&r, "1600000000 +0000", "older than its parent\n");
        git_at(&r, same, &["switch", "-qc", "late", "b2"]);
        commit_verbatim(&r, "1800000000 +0000", "newest\n");
        git_at(&r, same, &["switch", "-q", "main"]);
        git_at(&r, same, &["merge", "-q", "--no-ff", "-m", "merge late", "late"]);
        let details = assert_history_matches(&r);
        assert_eq!(details.len(), 12);
        assert_eq!(details.iter().filter(|c| c.parents.split(' ').count() == 4).count(), 1, "octopus merge present");
        for skip in 0..details.len() {
            assert_fast_path_matches(&r, Some(4), Some(skip));
        }
    }

    /// 有 commit-graph 时排序日期和父提交来自图：图里只存 34 位时间戳，git 读图时同样截断；
    /// 图之后新增的提交不在图里，仍读对象。两段混在一起、关掉 `core.commitGraph` 都要和 git 一致。
    #[test]
    fn commit_graph_dates_and_parents_order_like_git() {
        let (_d, r) = bare_repo();
        let same = "1700000000 +0000";
        commit_verbatim(&r, same, "root\n");
        for branch in ["b1", "b2"] {
            git_at(&r, same, &["switch", "-qc", branch, "main"]);
            commit_verbatim(&r, same, &format!("{branch} first\n"));
            commit_verbatim(&r, same, &format!("{branch} second\n"));
        }
        // 2^34 + 1700000000：对象里是这个数，图里截成 1700000000
        git_at(&r, same, &["switch", "-qc", "b3", "main"]);
        commit_verbatim(&r, "@18879869184 +0000", "beyond 34 bits\n");
        git_at(&r, same, &["switch", "-q", "main"]);
        commit_verbatim(&r, same, "main side\n");
        git_at(&r, same, &["merge", "-q", "--no-ff", "-m", "merge graphed", "b1", "b2", "b3"]);
        git_at(&r, same, &["commit-graph", "write", "--reachable"]);
        assert!(r.join(".git/objects/info/commit-graph").exists(), "fixture must have a commit-graph");
        let graphed = assert_history_matches(&r);
        assert_eq!(graphed.len(), 8);
        assert_eq!(
            graphed.iter().position(|c| c.summary == "beyond 34 bits"),
            Some(4),
            "graph date 1700000000 keeps the 2^34 commit in FIFO order behind its merge siblings"
        );

        git_at(&r, same, &["switch", "-qc", "late", "b2"]);
        commit_verbatim(&r, "1800000000 +0000", "newest\n");
        git_at(&r, same, &["switch", "-q", "main"]);
        commit_verbatim(&r, "1600000000 +0000", "older than its parent\n");
        git_at(&r, same, &["merge", "-q", "--no-ff", "-m", "merge late", "late"]);
        let mixed = assert_history_matches(&r);
        assert_eq!(mixed.len(), 11);
        for skip in 0..mixed.len() {
            assert_fast_path_matches(&r, Some(3), Some(skip));
        }

        git(&r, &["config", "core.commitGraph", "false"]);
        let ungraphed = assert_history_matches(&r);
        assert_ne!(ungraphed, mixed, "object dates sort the 2^34 commit first; graph dates do not");
        assert_eq!(
            ungraphed.iter().position(|c| c.summary == "beyond 34 bits"),
            Some(mixed.iter().position(|c| c.summary == "merge graphed").unwrap() + 1)
        );
    }

    #[test]
    fn subjects_bodies_and_trailers_match_git() {
        let (_d, r) = bare_repo();
        let messages = [
            "Only subject",
            "Subject with trailing spaces   \n",
            "Multi-line\nsubject   \n  continues\t\n\nBody paragraph.\n",
            "\n\n  \nLeading blank lines\n\nBody\n",
            "Empty body with blank lines after subject\n\n\n\n",
            "Trailers\n\nSome body text.\n\nSigned-off-by: Someone <someone@example.test>\nCo-authored-by: Other <other@example.test>\n",
            "Folded trailer\n\nReviewed-by: A very long\n  reviewer name\n\tacross lines <r@example.test>\nAcked-by: B\n",
            "Twenty-five percent rule passes\n\nSigned-off-by: S <s@example.test>\nnot a trailer line one\nnot a trailer line two\n",
            "Twenty-five percent rule fails\n\nSigned-off-by: S <s@example.test>\nnot one\nnot two\nnot three\nnot four\n",
            "Last paragraph is prose\n\nThis is a body.\n\nThe last paragraph: has a colon but\nis clearly prose.\n",
            "Cherry pick\n\nBody\n\n(cherry picked from commit 0123456789abcdef0123456789abcdef01234567)\n",
            "Cherry pick with trailers\n\n(cherry picked from commit 0123456789abcdef0123456789abcdef01234567)\nSigned-off-by: P <p@example.test>\n",
            "Comment lines\n\nBody\n\nKey: value\n# a comment inside the block\nOther-Key: other\n# trailing comment\n\n",
            "Old conflicts block\n\nSigned-off-by: C <c@example.test>\n\nConflicts:\n\tsome/file.txt\n\tother.txt\n",
            "Scissors\n\nKey: value\n# ------------------------ >8 ------------------------\nignored: stuff\n",
            "Separator variants\n\nKey:no-space\nSpaced key : value\nBug #43: not a trailer by default\n-dash-token: ok\n",
            "Continuation without trailer\n\n  indented first line\nKey: v\n  cont\n\n",
            "Whitespace-only line\n \nParagraph after a space-only line\n\nKey: v\n",
            "CRLF subject\r\nline two\r\n\r\nBody\r\n\r\nKey: value\r\n",
            "非 ASCII 标题 🎉\n\n正文：带全角冒号\n\nCo-authored-by: 协作者 <xie@example.test>\nSigned-off-by: 测试者 <t@t.t>\n",
            "Trailer without separator space\n\nSigned-off-by:X <x@x>\nKey:\n",
            "No trailing newline\n\nBody\n\nKey: value",
            "Subject only with trailer-looking second paragraph\n\nKey: value\n",
            "Blank line inside block\n\nKey: value\n\n\nOther: value\n",
        ];
        for (index, message) in messages.iter().enumerate() {
            commit_verbatim(&r, &format!("{} +0000", 1700000000 + index), message);
        }
        let details = assert_history_matches(&r);
        assert_eq!(details.len(), messages.len());
        let by_subject = |subject: &str| details.iter().find(|c| c.summary.starts_with(subject)).unwrap();
        assert_eq!(by_subject("Multi-line").summary, "Multi-line subject   continues");
        assert_eq!(by_subject("Empty body").body, "");
        assert_eq!(
            by_subject("Folded").trailers,
            "Reviewed-by: A very long reviewer name across lines <r@example.test>\nAcked-by: B\n"
        );
        assert_eq!(by_subject("Twenty-five percent rule passes").trailers, "Signed-off-by: S <s@example.test>\n");
        assert_eq!(by_subject("Twenty-five percent rule fails").trailers, "");
        assert_eq!(by_subject("Last paragraph is prose").trailers, "");
        assert_eq!(by_subject("Cherry pick with").trailers, "Signed-off-by: P <p@example.test>\n");
        assert_eq!(by_subject("Old conflicts").trailers, "Signed-off-by: C <c@example.test>\n");
        assert!(by_subject("非 ASCII").author.starts_with("测试者 <t@t.t> "));
        assert_eq!(
            by_subject("非 ASCII").trailers,
            "Co-authored-by: 协作者 <xie@example.test>\nSigned-off-by: 测试者 <t@t.t>\n"
        );
    }

    #[test]
    fn crafted_identities_match_git() {
        let (_d, r) = bare_repo();
        commit_verbatim(&r, "1700000000 +0000", "base\n");
        let tree = git_at(&r, "1700000000 +0000", &["rev-parse", "HEAD^{tree}"]);
        let parent = git_at(&r, "1700000000 +0000", &["rev-parse", "HEAD"]);
        let raw = format!(
            "tree {}\nparent {}\nauthor   Spaced  Name   <spaced@example.test>  1700000001  +0530\ncommitter Weird > Name <weird@example.test> 1700000002 -0000\n\nCrafted identities\n\nBody\n",
            tree.trim(),
            parent.trim()
        );
        let out = Command::new("git")
            .arg("-C")
            .arg(&r)
            .args(["hash-object", "-t", "commit", "-w", "--literally", "--stdin"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                std::io::Write::write_all(child.stdin.as_mut().unwrap(), raw.as_bytes())?;
                child.wait_with_output()
            })
            .unwrap();
        assert!(out.status.success());
        let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
        git_at(&r, "1700000000 +0000", &["update-ref", "refs/heads/main", &sha]);
        let details = assert_history_matches(&r);
        assert_eq!(details[0].author, "  Spaced  Name <spaced@example.test> 1700000001 +0530");
        assert_eq!(details[0].committer, "Weird > Name <weird@example.test> 1700000002 +0000");
    }

    #[test]
    fn pagination_matches_git() {
        let (_d, r) = bare_repo();
        for index in 0..12 {
            commit_verbatim(&r, &format!("{} +0000", 1700000000 + index), &format!("commit {index}\n"));
        }
        for (limit, skip) in
            [(None, None), (Some(0), None), (Some(5), Some(0)), (Some(5), Some(5)), (Some(5), Some(10))]
        {
            assert_fast_path_matches(&r, limit, skip);
        }
        assert_fast_path_matches(&r, Some(5), Some(12));
        assert_fast_path_matches(&r, Some(5), Some(99));
        assert_fast_path_matches(&r, None, Some(7));
        assert_eq!(assert_fast_path_matches(&r, Some(3), Some(2))[0].summary, "commit 9");
    }

    #[test]
    fn unborn_head_yields_empty_list_on_both_paths() {
        let (_d, r) = bare_repo();
        assert_eq!(details_via_gix(&r, None, None, None, &[]).unwrap(), Vec::new());
        assert_eq!(details_via_git(&r, None, None, None, &[]).unwrap(), Vec::new());
        assert_eq!(query_details(&r, None, Some(10), None, &[]).unwrap(), Vec::new());
    }

    #[test]
    fn abbreviation_follows_git_object_count_rules() {
        let (_d, r) = bare_repo();
        std::fs::create_dir_all(r.join("many")).unwrap();
        for index in 0..20_000 {
            std::fs::write(r.join("many").join(index.to_string()), format!("{index}\n")).unwrap();
        }
        git_at(&r, "1700000000 +0000", &["add", "many"]);
        git_at(&r, "1700000000 +0000", &["commit", "-qm", "twenty thousand loose objects"]);
        // 松散对象不计入估算：仍是 7 位
        assert_eq!(assert_history_matches(&r)[0].short_sha.len(), 7);
        git_at(&r, "1700000000 +0000", &["repack", "-a", "-d", "-q"]);
        assert_eq!(assert_history_matches(&r)[0].short_sha.len(), 8, "20k packed objects need 8 hex digits");
        commit_verbatim(&r, "1700000001 +0000", "on top\n");
        git_at(&r, "1700000001 +0000", &["repack", "-d", "-q"]);
        git_at(&r, "1700000001 +0000", &["multi-pack-index", "write"]);
        assert_eq!(assert_history_matches(&r)[0].short_sha.len(), 8, "multi-pack-index counts once");
        git_at(&r, "1700000001 +0000", &["config", "core.abbrev", "12"]);
        assert_eq!(assert_history_matches(&r)[0].short_sha.len(), 12);
        git_at(&r, "1700000001 +0000", &["config", "core.abbrev", "no"]);
        assert!(details_via_gix(&r, None, None, None, &[]).is_err(), "core.abbrev=no is left to git");
        assert_eq!(
            query_details(&r, None, None, None, &[]).unwrap(),
            details_via_git(&r, None, None, None, &[]).unwrap()
        );
    }

    #[test]
    fn configuration_that_changes_git_output_disables_fast_path() {
        let (_d, r) = bare_repo();
        commit_verbatim(&r, "1700000000 +0000", "first\n\nKey: value\n");
        git_at(&r, "1700000000 +0000", &["tag", "t"]);
        let plain = assert_history_matches(&r);
        for (key, value) in [
            ("log.decorate", "full"),
            ("log.excludeDecoration", "refs/tags/*"),
            ("log.initialDecorationSet", "all"),
            ("trailer.separators", ":="),
            ("trailer.key.key", "Key"),
            ("core.commentChar", ";"),
            ("i18n.logOutputEncoding", "ISO-8859-1"),
        ] {
            git_at(&r, "1700000000 +0000", &["config", key, value]);
            let refused = details_via_gix(&r, None, None, None, &[]);
            assert!(refused.is_err(), "{key}={value} must leave the fast path: {refused:?}");
            assert_eq!(
                query_details(&r, None, None, None, &[]).unwrap(),
                details_via_git(&r, None, None, None, &[]).unwrap()
            );
            git_at(&r, "1700000000 +0000", &["config", "--unset", key]);
        }
        for (key, value) in [("log.decorate", "short"), ("log.decorate", "false"), ("i18n.logOutputEncoding", "utf-8")]
        {
            git_at(&r, "1700000000 +0000", &["config", key, value]);
            assert_eq!(assert_history_matches(&r), plain, "{key}={value} keeps the output");
            git_at(&r, "1700000000 +0000", &["config", "--unset", key]);
        }
    }

    #[test]
    fn commits_with_encoding_headers_fall_back_to_git() {
        let (_d, r) = bare_repo();
        commit_verbatim(&r, "1700000000 +0000", "plain\n");
        assert_history_matches(&r);
        git_at(
            &r,
            "1700000001 +0000",
            &["-c", "i18n.commitEncoding=ISO-8859-1", "commit", "-q", "--allow-empty", "-m", "latin"],
        );
        assert!(details_via_gix(&r, None, None, None, &[]).is_err());
        assert_eq!(
            query_details(&r, None, None, None, &[]).unwrap(),
            details_via_git(&r, None, None, None, &[]).unwrap()
        );
        // 只翻到后面的页时编码提交不在页内，快速路径照常
        assert_fast_path_matches(&r, Some(1), Some(1));
    }

    #[test]
    fn ref_index_follows_head_branch_and_packing_changes() {
        let (_d, r) = bare_repo();
        commit_verbatim(&r, "1700000000 +0000", "first\n");
        assert_eq!(assert_history_matches(&r)[0].refs, "HEAD -> main");
        git_at(&r, "1700000000 +0000", &["switch", "-qc", "other"]);
        assert_eq!(assert_history_matches(&r)[0].refs, "HEAD -> other, main");
        commit_verbatim(&r, "1700000001 +0000", "second\n");
        let details = assert_history_matches(&r);
        assert_eq!(details[0].refs, "HEAD -> other");
        assert_eq!(details[1].refs, "main");
        git_at(&r, "1700000001 +0000", &["pack-refs", "--all"]);
        git_at(&r, "1700000001 +0000", &["branch", "-f", "main", "HEAD"]);
        assert_eq!(assert_history_matches(&r)[0].refs, "HEAD -> other, main");
        git_at(&r, "1700000001 +0000", &["update-ref", "-d", "refs/heads/main"]);
        assert_eq!(assert_history_matches(&r)[0].refs, "HEAD -> other");
        // 同一秒内改写同长度的引用也要被发现
        let tip = git_at(&r, "1700000001 +0000", &["rev-parse", "HEAD"]);
        git_at(&r, "1700000001 +0000", &["update-ref", "refs/heads/other", "HEAD~1"]);
        git_at(&r, "1700000001 +0000", &["update-ref", "refs/heads/other", tip.trim()]);
        assert_eq!(assert_history_matches(&r)[0].refs, "HEAD -> other");
    }

    /// 带修订号的查询：快速路径必须接管，且与 git 逐字节一致（含全量与几种翻页）。
    fn assert_revision_matches(root: &Path, revision: &str, additional: &[&str]) -> Vec<CommitDetails> {
        let additional: Vec<String> = additional.iter().map(ToString::to_string).collect();
        let mut all = Vec::new();
        for (limit, skip) in [(None, None), (Some(1), None), (Some(2), Some(1)), (Some(100), Some(3))] {
            let fast = details_via_gix(root, Some(revision), limit, skip, &additional)
                .unwrap_or_else(|reason| panic!("{revision} {additional:?}: fast path refused: {reason}"));
            let slow = details_via_git(root, Some(revision), limit, skip, &additional).unwrap();
            assert_eq!(fast, slow, "{revision} {additional:?} (limit {limit:?}, skip {skip:?})");
            if limit.is_none() {
                all = fast;
            }
        }
        all
    }

    /// 快速路径不接管的写法交给 git，结果仍与 git 相同。
    fn assert_left_to_git(root: &Path, revision: &str, additional: &[&str]) {
        let additional: Vec<String> = additional.iter().map(ToString::to_string).collect();
        assert!(
            details_via_gix(root, Some(revision), None, None, &additional).is_err(),
            "{revision} {additional:?} should be left to git"
        );
        assert_eq!(
            query_details(root, Some(revision), None, None, &additional).unwrap(),
            details_via_git(root, Some(revision), None, None, &additional).unwrap()
        );
    }

    #[test]
    fn 范围与排除远端的历史与_git_逐字节一致() {
        let (_d, r) = bare_repo();
        let at = |date: &str, args: &[&str]| git_at(&r, date, args);
        let commit = |date: &str, message: &str| at(date, &["commit", "--allow-empty", "-qm", message]);
        commit("1700000000 +0000", "root");
        commit("1700000100 +0000", "base");
        at("1700000100 +0000", &["branch", "feature"]);
        // main 上有一个日期倒错的提交：比它的父提交还早，git 的 SLOP 逻辑要靠它才能看出差别。
        commit("1700000300 +0000", "main one");
        commit("1700000050 +0000", "main skewed");
        commit("1700000400 +0000", "main two");
        at("1700000400 +0000", &["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
        at("1700000400 +0000", &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        at("1700000400 +0000", &["checkout", "-q", "feature"]);
        commit("1700000200 +0000", "feature one");
        commit("1700000350 +0000", "feature two");
        at("1700000350 +0000", &["merge", "-q", "--no-ff", "-m", "merge main", "main~2"]);
        commit("1700000500 +0000", "feature three");
        at("1700000500 +0000", &["tag", "light", "HEAD~1"]);
        at("1700000500 +0000", &["tag", "-a", "-m", "annotated", "annotated", "main~1"]);
        // 同名的分支和标签：git 按 ref_rev_parse_rules 先取 refs/tags。
        at("1700000500 +0000", &["branch", "same", "main"]);
        at("1700000500 +0000", &["tag", "same", "feature~2"]);

        let main = git(&r, &["rev-parse", "main"]);
        let main = main.trim();
        for revision in [
            "main..feature",
            "feature..main",
            "..main",
            "main..",
            "origin/main..feature",
            "origin..HEAD",
            "light..annotated",
            "refs/heads/main..refs/heads/feature",
            "feature..feature",
        ] {
            assert_revision_matches(&r, revision, &[]);
        }
        assert!(!assert_revision_matches(&r, &format!("{main}..feature"), &[]).is_empty());
        for revision in ["main", "feature", "light", "annotated", "same", "origin", "refs/remotes/origin/main", main] {
            assert_revision_matches(&r, revision, &[]);
        }
        assert_eq!(assert_revision_matches(&r, main, &[])[0].sha, main);
        for revision in ["HEAD", "main", "feature"] {
            assert_revision_matches(&r, revision, &["--not", "--remotes"]);
        }

        for revision in
            ["main...feature", "HEAD~1", "main^", "HEAD@{0}", &main[..7], "missing", "missing..main", "FETCH_HEAD"]
        {
            assert_left_to_git(&r, revision, &[]);
        }
        assert_left_to_git(&r, "main..feature", &["--not", "--remotes"]);
        assert_left_to_git(&r, "HEAD", &["--first-parent"]);

        // `rev-list --left-right --count A...B`：所有引用两两组合都与 git 相同。
        let names = ["main", "feature", "light", "annotated", "same", "origin/main", "HEAD", main];
        for a in names {
            for b in names {
                let range = format!("{a}...{b}");
                let fast = left_right_counts(&r, &range).unwrap_or_else(|reason| panic!("{range}: refused: {reason}"));
                assert_eq!(Some(fast), crate::ops::ahead_behind_via_git(&r, &range).unwrap(), "{range}");
                assert_eq!(crate::ops::ahead_behind_range(&r, &range).unwrap(), Some(fast));
            }
        }
        for range in ["main..feature", "main~1...feature", "missing...main", "main...feature...x"] {
            assert!(left_right_counts(&r, range).is_err(), "{range} should be left to git");
            assert_eq!(
                crate::ops::ahead_behind_range(&r, range).unwrap(),
                crate::ops::ahead_behind_via_git(&r, range).unwrap(),
                "{range}"
            );
        }
        // 没有共同祖先的两条历史：没有合并基，两侧各自全数。
        at("1700000600 +0000", &["checkout", "-q", "--orphan", "island"]);
        commit("1700000600 +0000", "island root");
        commit("1700000700 +0000", "island two");
        let fast = left_right_counts(&r, "island...main").unwrap();
        assert_eq!(Some(fast), crate::ops::ahead_behind_via_git(&r, "island...main").unwrap());
        at("1700000700 +0000", &["checkout", "-q", "feature"]);

        // 远端默认分支被删后留下悬空的 origin/HEAD：git 跳过它，快速路径让位。
        at("1700000500 +0000", &["update-ref", "-d", "refs/remotes/origin/main"]);
        assert_left_to_git(&r, "HEAD", &["--not", "--remotes"]);
        // 没有远端引用时 `--not --remotes` 什么都不排除，git 走非受限遍历。
        at("1700000500 +0000", &["update-ref", "--no-deref", "-d", "refs/remotes/origin/HEAD"]);
        assert_revision_matches(&r, "HEAD", &["--not", "--remotes"]);
    }

    /// 真实仓库里离 HEAD 较远的另一条线：第一个远端跟踪分支，没有就用最早的根提交。
    fn fast_tip(root: &Path) -> String {
        let remote = git(root, &["for-each-ref", "--count=1", "--format=%(objectname)", "refs/remotes"]);
        if !remote.trim().is_empty() {
            return remote.trim().to_string();
        }
        git(root, &["rev-list", "--max-parents=0", "--max-count=1", "HEAD"]).trim().to_string()
    }

    /// 选择性差分：`GITCUB_DIFFERENTIAL_REPOS` 用冒号分隔若干真实仓库，逐字段比较前 300 个提交。
    #[test]
    fn differential_against_git_on_real_repositories() {
        let Ok(list) = std::env::var("GITCUB_DIFFERENTIAL_REPOS") else { return };
        for path in list.split(':').filter(|path| !path.is_empty()) {
            let root = Path::new(path);
            let fast = details_via_gix(root, None, Some(300), None, &[])
                .unwrap_or_else(|reason| panic!("{path}: fast path refused: {reason}"));
            let slow = details_via_git(root, None, Some(300), None, &[]).unwrap();
            assert_eq!(fast.len(), slow.len(), "{path}: commit count");
            for (index, (ours, theirs)) in fast.iter().zip(&slow).enumerate() {
                assert_eq!(ours, theirs, "{path}: commit #{index}");
            }
            let page = details_via_gix(root, None, Some(100), Some(150), &[]).unwrap();
            assert_eq!(page, details_via_git(root, None, Some(100), Some(150), &[]).unwrap(), "{path}: page");
            assert_eq!(
                page,
                details_via_git(root, Some("HEAD"), Some(100), Some(150), &[]).unwrap(),
                "{path}: HEAD page"
            );
            let (count, width) = (fast.len(), fast[0].short_sha.len());
            let older = &fast[count.min(200) - 1].sha;
            for revision in [format!("{older}..HEAD"), format!("HEAD..{older}"), older.clone()] {
                let fast = details_via_gix(root, Some(&revision), Some(300), None, &[])
                    .unwrap_or_else(|reason| panic!("{path}: {revision}: fast path refused: {reason}"));
                assert_eq!(
                    fast,
                    details_via_git(root, Some(&revision), Some(300), None, &[]).unwrap(),
                    "{path}: {revision}"
                );
            }
            let additional = ["--not".to_string(), "--remotes".to_string()];
            let fast = details_via_gix(root, Some("HEAD"), Some(300), None, &additional)
                .unwrap_or_else(|reason| panic!("{path}: --not --remotes: fast path refused: {reason}"));
            assert_eq!(
                fast,
                details_via_git(root, Some("HEAD"), Some(300), None, &additional).unwrap(),
                "{path}: --not --remotes"
            );
            for range in [format!("{older}...HEAD"), format!("HEAD...{older}"), format!("{}...{older}", fast_tip(root))]
            {
                let fast = left_right_counts(root, &range)
                    .unwrap_or_else(|reason| panic!("{path}: {range}: refused: {reason}"));
                assert_eq!(Some(fast), crate::ops::ahead_behind_via_git(root, &range).unwrap(), "{path}: {range}");
            }
            eprintln!("{path}: {count} commits identical, short sha width {width}");
        }
    }

    /// 提交文件列表的进程内快速路径对照 `git log -C -M -m -1 --first-parent --raw --numstat -z` 的解析结果。
    /// 返回快速路径是否作答。
    fn compare_commit_files(r: &Path, sha: &str) -> bool {
        let via_git = serde_json::to_value(commit_files_via_git(r, sha).unwrap()).unwrap();
        match commit_files_in_process(r, sha) {
            Ok(fast) => {
                assert_eq!(serde_json::to_value(fast).unwrap(), via_git, "{sha}");
                true
            }
            Err(_) => false,
        }
    }

    fn head(r: &Path) -> String {
        git(r, &["rev-parse", "HEAD"]).trim().to_string()
    }

    #[test]
    fn 提交文件列表_进程内与_git_一致() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        let write = |path: &str, data: &str| {
            let path = r.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, data).unwrap();
        };
        let commit = |message: &str| {
            git(&r, &["add", "-A"]);
            git(&r, &["commit", "-qm", message, "--allow-empty"]);
            head(&r)
        };
        let body: String = (0..30).map(|i| format!("line {i}\n")).collect();
        // (提交, 快速路径是否应作答)
        let mut cases = Vec::new();
        write("a.txt", &body);
        write("dir/sub/b.txt", "b\n");
        write("空 格/中文.txt", "c\n");
        write("x.sh", "#!/bin/sh\n");
        cases.push((commit("root: 只有新增"), true));
        write("a.txt", &body.replace("line 3\n", "line three\n"));
        write("dir/sub/b.txt", "b2\n");
        cases.push((commit("只有修改"), true));
        std::fs::remove_file(r.join("空 格/中文.txt")).unwrap();
        cases.push((commit("只有删除"), true));
        write("new/deep/file.txt", "n\n");
        write("new/other.txt", "o\n");
        cases.push((commit("只有新增（目录）"), true));
        std::fs::set_permissions(r.join("x.sh"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        cases.push((commit("只改模式"), true));
        std::fs::remove_file(r.join("x.sh")).unwrap();
        std::os::unix::fs::symlink("a.txt", r.join("x.sh")).unwrap();
        cases.push((commit("文件变符号链接"), true));
        write("a.txt", &body);
        write("added.txt", "fresh\n");
        cases.push((commit("新增加修改：-C -M 只做重命名，来源只是删除"), true));
        git(&r, &["mv", "added.txt", "renamed.txt"]);
        cases.push((commit("重命名"), true));
        std::fs::remove_file(r.join("dir/sub/b.txt")).unwrap();
        write("dir/sub/b.txt/inner.txt", "now a dir\n");
        cases.push((commit("文件变目录：一删一增，按树序排在一起"), true));
        cases.push((commit("空提交"), true));
        // 合并提交：对第一父的差异
        git(&r, &["checkout", "-q", "-b", "side"]);
        write("side.txt", "side\n");
        commit("side");
        git(&r, &["checkout", "-q", "main"]);
        write("a.txt", &body.replace("line 9\n", "line nine\n"));
        commit("main");
        git(&r, &["merge", "-q", "--no-ff", "--no-edit", "side"]);
        cases.push((head(&r), true));
        git(&r, &["checkout", "-q", "side"]);
        write("side.txt", "side 2\n");
        commit("side 2");
        git(&r, &["checkout", "-q", "main"]);
        git(&r, &["merge", "-q", "--no-ff", "--no-edit", "side"]);
        let merge_modify = head(&r);
        cases.push((merge_modify.clone(), true));

        for (sha, fast) in &cases {
            assert_eq!(compare_commit_files(&r, sha), *fast, "{sha}: {}", git(&r, &["log", "-1", "--format=%s", sha]));
        }
        // 配置让位
        let root = &cases[0].0;
        git(&r, &["config", "log.showRoot", "false"]);
        assert!(!compare_commit_files(&r, root));
        git(&r, &["config", "--unset", "log.showRoot"]);
        git(&r, &["config", "log.diffMerges", "combined"]);
        assert!(!compare_commit_files(&r, &merge_modify));
        git(&r, &["config", "--unset", "log.diffMerges"]);
        // 短 SHA 与替换对象
        assert!(commit_files_in_process(&r, &root[..12]).is_err());
        git(&r, &["replace", &cases[1].0, &cases[2].0]);
        assert!(!compare_commit_files(&r, &cases[1].0));
    }

    /// 每个文件的增删行数对照 `git show --numstat`：文本、重命名带修改、二进制（`-`）、只改模式。
    /// 快速路径与 git 路径都要给出相同的数字；Desktop（log.ts parseRawLogWithNumstat）把 `-` 按 0 计入总数。
    #[test]
    fn 提交文件行数_与_git_show_numstat_一致() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        let write = |path: &str, data: &[u8]| {
            let path = r.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, data).unwrap();
        };
        let commit = |message: &str| {
            git(&r, &["add", "-A"]);
            git(&r, &["commit", "-qm", message, "--allow-empty"]);
            head(&r)
        };
        let body: String = (0..40).map(|i| format!("line {i}\n")).collect();
        write("a.txt", body.as_bytes());
        write("image.bin", &[0, 159, 146, 150, 0, 1, 2, 3]);
        write("x.sh", b"#!/bin/sh\n");
        let mut shas = vec![commit("root")];
        write("a.txt", body.replace("line 3\n", "line three\nline 3b\n").replace("line 10\n", "").as_bytes());
        write("image.bin", &[0, 159, 146, 150, 9, 9, 9]);
        shas.push(commit("text and binary edits"));
        std::fs::rename(r.join("a.txt"), r.join("b.txt")).unwrap();
        write("b.txt", body.replace("line 3\n", "line three\nline 3b\n").replace("line 30\n", "LINE 30\n").as_bytes());
        shas.push(commit("rename with modifications"));
        std::fs::set_permissions(r.join("x.sh"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        shas.push(commit("mode only"));
        std::fs::remove_file(r.join("image.bin")).unwrap();
        shas.push(commit("delete binary"));

        for sha in &shas {
            let out = Command::new("git")
                .arg("-C")
                .arg(&r)
                .args([
                    "show",
                    "--format=format:",
                    "--numstat",
                    "-z",
                    "-C",
                    "-M",
                    "--first-parent",
                    "--end-of-options",
                    sha,
                ])
                .output()
                .unwrap();
            assert!(out.status.success());
            let mut expected: Vec<(String, Option<u64>, Option<u64>)> = Vec::new();
            let mut fields = out.stdout.split(|b| *b == 0);
            while let Some(field) = fields.next() {
                if field.is_empty() {
                    continue;
                }
                let mut parts = field.splitn(3, |b| *b == b'\t');
                let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
                    continue;
                };
                let count = |text: &[u8]| (text != b"-").then(|| String::from_utf8_lossy(text).parse::<u64>().unwrap());
                let path = if path.is_empty() {
                    fields.next();
                    fields.next().unwrap()
                } else {
                    path
                };
                expected.push((String::from_utf8_lossy(path).into_owned(), count(added), count(deleted)));
            }
            expected.sort();
            let fast =
                commit_files_in_process(&r, sha).unwrap_or_else(|reason| panic!("{sha}: 快速路径让位: {reason}"));
            let via_git = commit_files_via_git(&r, sha).unwrap();
            for files in [&fast, &via_git] {
                let mut actual: Vec<(String, Option<u64>, Option<u64>)> =
                    files.iter().map(|file| (file.path.clone(), file.lines_added, file.lines_deleted)).collect();
                actual.sort();
                assert_eq!(actual, expected, "{sha}: {}", git(&r, &["log", "-1", "--format=%s", sha]));
            }
            assert_eq!(serde_json::to_value(&fast).unwrap(), serde_json::to_value(&via_git).unwrap(), "{sha}");
        }
        // 二进制文件是 None，文本文件有数字，改模式是 0/0
        let edits = commit_files(&r, &shas[1]).unwrap();
        let image = edits.iter().find(|file| file.path == "image.bin").unwrap();
        assert_eq!((image.lines_added, image.lines_deleted), (None, None));
        let text = edits.iter().find(|file| file.path == "a.txt").unwrap();
        assert_eq!((text.lines_added, text.lines_deleted), (Some(2), Some(2)));
        let mode = commit_files(&r, &shas[3]).unwrap();
        assert_eq!((mode[0].lines_added, mode[0].lines_deleted), (Some(0), Some(0)));
    }

    /// 随机提交序列：每一步随机新增、修改、删除、改模式，与 git 对照可作答的那些。
    #[test]
    fn 提交文件列表_随机提交与_git_一致() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        let mut state = 0x1234_5678_9abc_def0_u64;
        let mut next = |n: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % n as u64) as usize
        };
        let mut files: Vec<String> = Vec::new();
        let (mut fast, mut total) = (0, 0);
        for step in 0..120 {
            // 每次提交只做一类操作，多数提交因此可由快速路径作答
            let op = if files.is_empty() { 0 } else { next(4) };
            for _ in 0..1 + next(4) {
                match op {
                    0 => {
                        let name = format!("d{}/f{step}-{}.txt", next(3), next(1000));
                        std::fs::create_dir_all(r.join(&name).parent().unwrap()).unwrap();
                        std::fs::write(r.join(&name), format!("{step}\n")).unwrap();
                        files.push(name);
                    }
                    1 if !files.is_empty() => {
                        let name = &files[next(files.len())];
                        std::fs::write(r.join(name), format!("edit {step} {}\n", next(1000))).unwrap();
                    }
                    2 if files.len() > 1 => {
                        let name = files.remove(next(files.len()));
                        std::fs::remove_file(r.join(name)).unwrap();
                    }
                    _ if !files.is_empty() => {
                        use std::os::unix::fs::PermissionsExt;
                        let name = &files[next(files.len())];
                        let mode = if next(2) == 0 { 0o755 } else { 0o644 };
                        std::fs::set_permissions(r.join(name), std::fs::Permissions::from_mode(mode)).unwrap();
                    }
                    _ => {}
                }
            }
            git(&r, &["add", "-A"]);
            git(&r, &["commit", "-qm", &format!("step {step}"), "--allow-empty"]);
            total += 1;
            if compare_commit_files(&r, &head(&r)) {
                fast += 1;
            }
        }
        assert!(fast * 10 >= total * 9, "快速路径只作答了 {fast}/{total}");
    }

    fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "测试者"]);
        std::fs::write(r.join("a.txt"), "1\n2\n").unwrap();
        git(&r, &["add", "a.txt"]);
        git(&r, &["commit", "-qm", "第一次提交"]);
        std::fs::write(r.join("a.txt"), "1\n2改\n").unwrap();
        std::fs::write(r.join("b.txt"), "新文件\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "第二次提交\n\n正文说明"]);
        (d, r)
    }

    /// 搜索夹具：main 上两个提交（第二个作者是 Bob、打了 v1），feature 分支一个提交，再 `--no-ff` 合并。
    /// 提交时间递增，`git log --all` 的顺序固定为 合并、feature work、Fix crash、Initial import。
    fn search_repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "alice@example.test"]);
        git(&r, &["config", "user.name", "Alice Search"]);
        std::fs::create_dir_all(r.join("src")).unwrap();
        std::fs::write(r.join("src/index.ts"), "function helper() {}\n").unwrap();
        std::fs::write(r.join("README.md"), "# demo\n").unwrap();
        git(&r, &["add", "."]);
        git_at(&r, "2020-01-01T12:00:00+00:00", &["commit", "-qm", "Initial import"]);
        std::fs::write(r.join("src/index.ts"), "function assist() {}\n").unwrap();
        git_at(
            &r,
            "2021-06-01T00:00:00+00:00",
            &["commit", "-qam", "Fix crash in helper\n\nDetails", "--author=Bob <bob@example.test>"],
        );
        git(&r, &["tag", "v1"]);
        git(&r, &["checkout", "-q", "-b", "feature", "HEAD~1"]);
        std::fs::create_dir_all(r.join("docs")).unwrap();
        std::fs::write(r.join("docs/guide.md"), "guide\n").unwrap();
        git(&r, &["add", "docs"]);
        git_at(&r, "2022-01-01T00:00:00+00:00", &["commit", "-qm", "feature work"]);
        git(&r, &["checkout", "-q", "main"]);
        git_at(&r, "2022-02-01T00:00:00+00:00", &["merge", "-q", "--no-ff", "-m", "Merge branch 'feature'", "feature"]);
        (d, r)
    }

    fn sha(r: &Path, revision: &str) -> String {
        git(r, &["rev-parse", revision]).trim().to_string()
    }

    fn query(text: &str) -> crate::search_query::SearchQuery {
        crate::search_query::SearchQuery { query: text.to_string(), ..Default::default() }
    }

    fn summaries(r: &Path, search: &crate::search_query::SearchQuery) -> Vec<String> {
        super::search(r, search, 100, 0).unwrap().into_iter().map(|c| c.summary).collect()
    }

    #[test]
    fn 搜索消息_作者与提交者() {
        let (_d, r) = search_repo();
        assert_eq!(summaries(&r, &query("crash")), ["Fix crash in helper"]);
        assert_eq!(summaries(&r, &query("message:Initial")), ["Initial import"]);
        assert_eq!(summaries(&r, &query("author:Bob")), ["Fix crash in helper"]);
        assert_eq!(summaries(&r, &query("@:bob")), ["Fix crash in helper"], "正则模式默认忽略大小写");
        assert_eq!(summaries(&r, &query("committer:Alice")).len(), 4, "提交者全是 Alice");
        assert_eq!(summaries(&r, &query("-message:crash")).len(), 3);
        let found = super::search(&r, &query("author:Bob"), 100, 0).unwrap();
        assert_eq!(found[0].author_name, "Bob");
        assert_eq!(found[0].author_email, "bob@example.test");
        assert_eq!(found[0].time, 1622505600);
        assert_eq!(found[0].tags, vec!["v1".to_string()]);
        assert_eq!(found[0].body.trim(), "Details");
        assert_eq!(found[0].sha, sha(&r, "v1"));
    }

    #[test]
    fn 搜索带引号的短语() {
        let (_d, r) = search_repo();
        assert_eq!(summaries(&r, &query("\"crash in\"")), ["Fix crash in helper"]);
        assert_eq!(summaries(&r, &query("message:\"Fix crash\" author:\"Bob\"")), ["Fix crash in helper"]);
        assert!(summaries(&r, &query("\"crash helper\"")).is_empty(), "引号内是整段匹配");
    }

    #[test]
    fn 按文件通配与_glob_搜索() {
        let (_d, r) = search_repo();
        assert_eq!(summaries(&r, &query("file:index")), ["Fix crash in helper", "Initial import"]);
        // 上游把 `:(icase)` 和 `:(glob)` 叠成两段魔法前缀，git 只认第一段，剩下的当字面量：
        // 不区分大小写时 glob 搜不到任何东西，这是原版 search.utils 的行为，照搬。
        assert!(summaries(&r, &query("?:**/*.md")).is_empty());
        let glob = crate::search_query::SearchQuery { match_case: Some(true), ..query("?:**/*.md") };
        assert_eq!(summaries(&r, &glob), ["feature work", "Initial import"], "只有 :(glob) 时正常");
        assert_eq!(summaries(&r, &query("file:\"docs/guide.md\"")), ["feature work"]);
        assert_eq!(summaries(&r, &query("file:readme")), ["Initial import"], "默认 :(icase)");
        let case = crate::search_query::SearchQuery { match_case: Some(true), ..query("file:readme") };
        assert!(summaries(&r, &case).is_empty(), "区分大小写时不再加 :(icase)");
    }

    #[test]
    fn 按改动内容搜索_s_与_g() {
        let (_d, r) = search_repo();
        let fixed = crate::search_query::SearchQuery { match_regex: Some(false), ..query("change:helper") };
        assert_eq!(summaries(&r, &fixed), ["Fix crash in helper", "Initial import"], "-S");
        assert_eq!(summaries(&r, &query("~:hel.er")), ["Fix crash in helper", "Initial import"], "-G 正则");
        assert!(
            summaries(&r, &crate::search_query::SearchQuery { match_regex: Some(false), ..query("~:hel.er") })
                .is_empty()
        );
    }

    #[test]
    fn 按日期_引用与合并类型搜索() {
        let (_d, r) = search_repo();
        assert_eq!(
            summaries(&r, &query("after:2021-01-01")),
            ["Merge branch 'feature'", "feature work", "Fix crash in helper"]
        );
        assert_eq!(summaries(&r, &query("before:2020-12-31")), ["Initial import"]);
        assert_eq!(summaries(&r, &query(">:2021-01-01 <:2021-12-31")), ["Fix crash in helper"]);
        assert_eq!(summaries(&r, &query("ref:feature")), ["feature work", "Initial import"], "不再 --all");
        assert_eq!(summaries(&r, &query("^:v1..main")), ["Merge branch 'feature'", "feature work"]);
        assert_eq!(summaries(&r, &query("type:merge")), ["Merge branch 'feature'"]);
        assert_eq!(summaries(&r, &query("is:tip")), ["Merge branch 'feature'", "feature work", "Fix crash in helper"]);
    }

    #[test]
    fn 按长短_sha_搜索() {
        let (_d, r) = search_repo();
        let fix = sha(&r, "v1");
        let initial = sha(&r, "v1~1");
        assert_eq!(summaries(&r, &query(&fix)), ["Fix crash in helper"], "裸 40 位 sha 识别为 commit:");
        assert_eq!(summaries(&r, &query(&format!("#:{}", &fix[..7]))), ["Fix crash in helper"]);
        assert_eq!(
            summaries(&r, &query(&format!("commit:{} #:{}", &initial[..8], fix))),
            ["Fix crash in helper", "Initial import"]
        );
        assert!(summaries(&r, &query("#:0123456789ab")).is_empty(), "解析不到的短 sha 不能退化成 HEAD");
        assert_eq!(summaries(&r, &query("#:v1")), ["Fix crash in helper"], "非十六进制的值原样交给 git");
    }

    #[test]
    fn me_取仓库的_user_name() {
        let (_d, r) = search_repo();
        assert_eq!(summaries(&r, &query("@me")), ["Merge branch 'feature'", "feature work", "Initial import"]);
        assert_eq!(summaries(&r, &query("committer:@me")).len(), 4);
        git(&r, &["config", "user.name", ""]);
        assert_eq!(summaries(&r, &query("@me")).len(), 4, "user.name 为空时 @me 被跳过，退回 --all");
    }

    #[test]
    fn 匹配开关() {
        let (_d, r) = search_repo();
        let q = |text: &str, all: bool, case: bool, regex: bool, word: bool| crate::search_query::SearchQuery {
            match_all: Some(all),
            match_case: Some(case),
            match_regex: Some(regex),
            match_whole_word: Some(word),
            ..query(text)
        };
        assert_eq!(summaries(&r, &q("cra.h", false, false, true, false)), ["Fix crash in helper"]);
        assert!(summaries(&r, &q("cra.h", false, false, false, false)).is_empty(), "固定字符串");
        assert_eq!(summaries(&r, &q("fix", false, false, true, false)), ["Fix crash in helper"]);
        assert!(summaries(&r, &q("fix", false, true, true, false)).is_empty(), "区分大小写");
        assert!(summaries(&r, &q("fix", false, true, false, false)).is_empty(), "固定字符串也区分大小写");
        assert_eq!(summaries(&r, &q("cras", false, false, true, false)), ["Fix crash in helper"]);
        assert!(summaries(&r, &q("cras", false, false, true, true)).is_empty(), "全字匹配");
        // 全字匹配靠 ERE 的 `\b`，和 GitLens 一样取决于 git 链接的正则库（Apple Git 不认 `\b`），
        // 所以只断言与 git 自己对同一模式的结果一致。
        let expected = git(
            &r,
            &["log", "--all", "--format=%s", "--extended-regexp", "--regexp-ignore-case", "--grep=\\bcrash\\b"],
        );
        assert_eq!(summaries(&r, &q("crash", false, false, true, true)), expected.lines().collect::<Vec<_>>());
        assert_eq!(
            summaries(&r, &q("message:Fix message:import", false, false, true, false)),
            ["Fix crash in helper", "Initial import"],
            "多条消息默认任一匹配"
        );
        assert!(summaries(&r, &q("message:Fix message:import", true, false, true, false)).is_empty());
        assert_eq!(summaries(&r, &q("message:Fix message:crash", true, false, true, false)), ["Fix crash in helper"]);
    }

    #[test]
    fn 限制数量与跳过() {
        let (_d, r) = search_repo();
        let page = |limit, skip| {
            super::search(&r, &query("committer:Alice"), limit, skip)
                .unwrap()
                .into_iter()
                .map(|c| c.summary)
                .collect::<Vec<_>>()
        };
        assert_eq!(page(2, 0), ["Merge branch 'feature'", "feature work"]);
        assert_eq!(page(2, 1), ["feature work", "Fix crash in helper"]);
        assert_eq!(page(10, 3), ["Initial import"]);
        assert_eq!(page(0, 0).len(), 4, "0 表示不限");
    }

    #[test]
    fn 空查询与语法错误() {
        let (_d, r) = search_repo();
        assert!(summaries(&r, &query("")).is_empty());
        assert!(summaries(&r, &query("   ")).is_empty());
        assert_eq!(super::search(&r, &query("message:"), 100, 0).unwrap_err(), "'message:' requires a value");
        assert_eq!(
            super::search(&r, &query("message:fix -message:wip"), 100, 0).unwrap_err(),
            "Cannot combine 'message:' and '-message:' in the same query"
        );
    }

    #[test]
    fn 贮藏参与搜索并可单独筛选() {
        let (_d, r) = search_repo();
        std::fs::write(r.join("README.md"), "# demo\nchanged\n").unwrap();
        git_at(&r, "2022-03-01T00:00:00+00:00", &["stash", "push", "-q", "-m", "stash README"]);
        let stash = sha(&r, "refs/stash");
        let found = super::search(&r, &query("type:stash"), 100, 0).unwrap();
        assert_eq!(found.iter().map(|c| c.sha.as_str()).collect::<Vec<_>>(), [stash.as_str()]);
        assert_eq!(found[0].summary, "On main: stash README");
        assert_eq!(summaries(&r, &query("message:stash")), ["On main: stash README"], "贮藏经 --stdin 进入普通搜索");
        let by_file = super::search(&r, &query("is:stash file:README"), 100, 0).unwrap();
        assert_eq!(
            by_file.iter().map(|c| c.sha.as_str()).collect::<Vec<_>>(),
            [stash.as_str()],
            "索引父提交归并为贮藏且只计一次"
        );
        assert_eq!(summaries(&r, &query("type:merge")), ["Merge branch 'feature'"], "多父的贮藏不算合并提交");
    }

    #[test]
    fn 对比两条分支各自独有的提交() {
        let (_d, r) = repo();
        git(&r, &["switch", "-qc", "他们"]);
        std::fs::write(r.join("t.txt"), "他们的\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "他们做的事"]);
        git(&r, &["switch", "-q", "-"]);
        std::fs::write(r.join("o.txt"), "我们的\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "我们做的事"]);

        let c = compare(&r, "HEAD", "他们", 100).unwrap();
        assert_eq!(c.ahead.len(), 1, "我们独有一条");
        assert_eq!(c.ahead[0].summary, "我们做的事");
        assert_eq!(c.behind.len(), 1, "对方独有一条");
        assert_eq!(c.behind[0].summary, "他们做的事");
        assert!(!c.ahead[0].author_name.is_empty());
        assert!(c.ahead[0].time > 0);
        assert_eq!(c.ahead[0].parent_count, 1);
    }

    #[test]
    fn 对比同一条分支时两边都是空() {
        let (_d, r) = repo();
        let c = compare(&r, "HEAD", "HEAD", 100).unwrap();
        assert!(c.ahead.is_empty() && c.behind.is_empty());
    }

    /// 提交正文里带空行和特殊字符时不能把记录切错
    #[test]
    fn 带正文的提交解析得出来() {
        let (_d, r) = repo();
        git(&r, &["switch", "-qc", "带正文"]);
        std::fs::write(r.join("x.txt"), "x\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "摘要行", "-m", "第一段\n\n第二段 带 \\x01 这种字样"]);

        let c = compare(&r, "带正文", "main", 100).unwrap();
        let first = c.ahead.first().expect("应有一条");
        assert_eq!(first.summary, "摘要行");
        assert!(first.body.contains("第一段"), "正文: {:?}", first.body);
        assert!(first.body.contains("第二段"), "正文: {:?}", first.body);
    }

    #[test]
    fn 提交列表按时间倒序且带作者() {
        let (_d, r) = repo();
        let l = log(&r, 10, 0).unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].summary, "第二次提交");
        assert_eq!(l[0].body.trim(), "正文说明");
        assert_eq!(l[1].summary, "第一次提交");
        assert_eq!(l[0].author_name, "测试者");
        assert_eq!(l[0].short_sha.len(), 7);
        assert!(l[0].time > 0);
    }

    #[test]
    fn 空仓库返回空列表而不是报错() {
        let d = tempfile::tempdir().unwrap();
        git(d.path(), &["init", "-q", "-b", "main", "."]);
        assert!(log(d.path(), 10, 0).unwrap().is_empty());
    }

    #[test]
    fn 某次提交改了哪些文件() {
        let (_d, r) = repo();
        let l = log(&r, 10, 0).unwrap();
        let files = commit_files(&r, &l[0].sha).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].kind, CommitFileKind::Modified);
        assert_eq!(files[1].path, "b.txt");
        assert_eq!(files[1].kind, CommitFileKind::Added);
    }

    #[test]
    fn 根提交的文件全部算新增() {
        let (_d, r) = repo();
        let l = log(&r, 10, 0).unwrap();
        // 根提交没有父，应与空树比较
        let files = commit_files(&r, &l[1].sha).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].kind, CommitFileKind::Added);
    }

    #[test]
    fn 目录不会被当成文件列出来() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        std::fs::create_dir_all(r.join("src/inner")).unwrap();
        std::fs::write(r.join("src/inner/a.txt"), "x\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "带目录的提交"]);

        let l = log(&r, 10, 0).unwrap();
        let files = commit_files(&r, &l[0].sha).unwrap();
        // 只应有那一个文件，不该出现 "src" 或 "src/inner"
        assert_eq!(files.len(), 1, "实际: {:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>());
        assert_eq!(files[0].path, "src/inner/a.txt");
    }

    #[test]
    fn 重命名会被识别并显示新路径() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        std::fs::write(r.join("old.txt"), "内容足够长才能被相似度检测认出来\n".repeat(10)).unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "init"]);
        git(&r, &["mv", "old.txt", "new.txt"]);
        git(&r, &["commit", "-qm", "重命名"]);

        let l = log(&r, 10, 0).unwrap();
        let files = commit_files(&r, &l[0].sha).unwrap();
        assert_eq!(files.len(), 1, "实际: {files:?}");
        assert_eq!(files[0].kind, CommitFileKind::Renamed, "应识别为重命名");
        assert_eq!(files[0].path, "new.txt", "应显示新路径");
    }

    #[test]
    fn 非_ascii_路径不被转义() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        // 故意开启 quotepath —— 走 -z 的话它不该生效
        git(&r, &["config", "core.quotepath", "true"]);
        std::fs::write(r.join("中文文件.txt"), "x\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "中文"]);

        let l = log(&r, 10, 0).unwrap();
        let files = commit_files(&r, &l[0].sha).unwrap();
        assert_eq!(files[0].path, "中文文件.txt", "路径被转义了: {:?}", files[0].path);
    }

    #[test]
    fn 单个文件在某次提交里的_diff() {
        let (_d, r) = repo();
        let l = log(&r, 10, 0).unwrap();
        // 走 raw_diff：git 参数照搬原版 getCommitDiff，输出交给前端的移植解析器
        let text = crate::raw_diff::commit_file_diff(&r, &l[0].sha, "a.txt", None, false).unwrap();
        assert!(text.contains("-2"), "应有被删的旧行: {text}");
        assert!(text.contains("+2改"), "应有新增的新行: {text}");
        assert!(text.contains("@@"), "应是统一 diff 格式");
    }

    /// Desktop getCommitDiff 对重命名/复制追加旧路径；只给新路径时 git 看不到重命名，整份内容成了新增。
    #[test]
    fn 重命名文件的提交_diff_带上旧路径() {
        let (_d, r) = repo();
        let body: String = (0..20).map(|i| format!("line {i}\n")).collect();
        std::fs::write(r.join("old.txt"), &body).unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "add"]);
        git(&r, &["mv", "old.txt", "new.txt"]);
        std::fs::write(r.join("new.txt"), body.replace("line 3\n", "line three\n")).unwrap();
        git(&r, &["commit", "-qam", "rename"]);
        let sha = log(&r, 1, 0).unwrap()[0].sha.clone();
        let files = commit_files(&r, &sha).unwrap();
        assert_eq!(files[0].old_path.as_deref(), Some("old.txt"));

        let with_old = crate::raw_diff::commit_file_diff(&r, &sha, "new.txt", Some("old.txt"), false).unwrap();
        assert!(with_old.contains("old.txt\0new.txt"), "raw 行应是重命名: {with_old:?}");
        assert!(with_old.contains("-line 3") && with_old.contains("+line three"), "只应有改动的那一行");
        assert!(!with_old.contains("+line 0"), "不应整份变成新增");
        let without = crate::raw_diff::commit_file_diff(&r, &sha, "new.txt", None, false).unwrap();
        assert!(without.contains("+line 0"), "没有旧路径时 git 只看到新增：{without:?}");
    }

    /// GitLens getFileDiffPathspecs「ignores an empty original path」：空旧路径若照传，
    /// git 以「empty string is not a valid pathspec」拒绝整条命令。
    #[test]
    fn 空的旧路径不进入提交_diff_的_pathspec() {
        let (_d, r) = repo();
        let l = log(&r, 10, 0).unwrap();
        let text = crate::raw_diff::commit_file_diff(&r, &l[0].sha, "a.txt", Some(""), false).unwrap();
        assert!(text.contains("+2改"), "应与不带旧路径时一样给出 diff: {text}");
    }
}
