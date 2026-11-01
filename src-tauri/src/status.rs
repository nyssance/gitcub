//! 仓库状态 —— 主界面的数据来源。
//!
//! 全程在进程内由 gix 完成。这正是整个架构的意义所在：status 是热路径，
//! 每次文件变化都要重跑，GitHub Desktop 慢就慢在它每次都 fork 一个 `git status`。
//!
//! 少数几处还是要起 git（gix 给不出的信息），那些一律带 `--no-optional-locks`
//! ——照原版 getStatus。git 的只读命令默认会顺手刷新并**写回 index**（要拿
//! index.lock），我们现在是文件监听驱动的，一次构建能触发好几十次状态查询，
//! 跟用户自己的 git 抢锁只是时间问题。

use serde::Serialize;
use std::path::Path;

#[cfg(unix)]
#[path = "status/preload.rs"]
pub(crate) mod preload;
#[path = "status/tree_index.rs"]
pub(crate) mod tree_index;
#[cfg(unix)]
#[path = "status/untracked_cache.rs"]
pub(crate) mod untracked_cache;

/// 改动**类型**：新增 / 修改 / 删除 / 重命名。
///
/// 这和「暂存到哪一步」是两个正交的东西，之前只有后者，于是删除、重命名在
/// 列表里和普通修改长得一模一样（同一个图标同一个颜色）。原版是四种图标四种
/// 颜色（iconForStatus），一眼能分辨——这是列表最基本的信息。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
    /// 从别的文件复制出来的（git 的 `C` 状态，要开了 `-C` 才检测得到）
    Copied,
    /// 合并/变基留下的冲突。这个必须单独成一类：它长得像「修改」，
    /// 但里面可能还夹着 `<<<<<<<` 标记，直接提交会把标记写进历史。
    Conflicted,
}

/// 子模块的脏法。三件事是分开的，界面上的行为也不一样：
///
///   - `commit_changed`：子模块指向的提交变了 —— **只有这一项**能提交进父仓库
///   - `modified` / `untracked`：子模块**内部**还有没提交的东西 ——
///     这些得先在子模块自己那边提交，父仓库这边拿不走
///
/// 原版（filter-changes-list.tsx）据此决定复选框：只有内部改动、指向的提交
/// 没变时复选框直接禁用（勾了也提交不了任何东西）；两者都有时显示成半选。
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub commit_changed: bool,
    pub modified: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    /// 工作区有改动，但未暂存
    Unstaged,
    /// 已暂存（HEAD 与 index 之间有差异）
    Staged,
    /// 两者都有 —— 典型的部分暂存结果
    Both,
    /// 未跟踪的新文件
    Untracked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// 暂存到哪一步
    pub kind: ChangeKind,
    /// 改动类型，决定图标和颜色
    pub change: ChangeType,
    /// 重命名前的路径。列表里要显示「旧名 → 新名」，取消勾选时也要用它
    /// 把旧路径一起退回——重命名在 index 里是两条记录。
    pub old_path: Option<String>,
    /// 冲突细节。只有 change == Conflicted 时才有值。
    pub conflict: Option<Conflict>,
    /// 这条改动是个子模块时的细节。普通文件是 None。
    pub submodule: Option<Submodule>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: Option<String>,
    pub changes: Vec<FileChange>,
    /// 远端名（通常是 origin）。没有远端时为 None，工具栏应显示「发布分支」。
    pub remote: Option<String>,
    /// 当前分支是否已设置上游。未设置时 ahead/behind 无意义。
    pub has_upstream: bool,
    pub ahead: u32,
    pub behind: u32,
    /// 卡在哪个多步操作里（合并/变基/摘取/回滚）。None = 没有在进行的操作。
    pub operation: Option<crate::ops::Operation>,
    /// 「对面」那条分支：合并时是被合进来的那条，变基时是变基到的那条。
    pub theirs: Option<String>,
    /// 当前分支还没有任何提交（Desktop TipState.Unborn）
    pub unborn: bool,
    /// HEAD 指向的提交；未诞生分支为 None。Desktop 拿它判断改写过的分支是否仍在原处（forcePushBranches）
    pub head: Option<String>,
    /// git 目录里的 FETCH_HEAD：Desktop git-store updateLastFetched 用它的修改时间当「上次拉取」
    pub fetch_head: Option<FetchHead>,
    /// Desktop git-store checkPullWithRebase：`pull.rebase` 原样是 "true" / "false" 才有值，其余（没设、merges 等）为 None
    pub pull_with_rebase: Option<bool>,
    /// Desktop Branch.upstream（`%(upstream:short)`，如 `origin/other`）：从配置读，跟踪引用不在也有值
    pub upstream: Option<String>,
    /// Desktop Branch.upstreamRemoteName（`%(upstream:remotename)`）
    pub upstream_remote_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchHead {
    /// 修改时间，Unix 毫秒
    pub modified_ms: f64,
    /// 空文件多半是拉取失败了，Desktop 这时不更新上次拉取时间
    pub empty: bool,
}

/// Desktop getBranches 的 `%(upstream:short)` 与 `%(upstream:remotename)`：按 branch.<name>.remote / merge 配置算出
/// 上游的跟踪引用并去掉 refs/remotes/ 前缀，不起 git 进程
fn upstream_of(repo: &gix::Repository, branch: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(branch) = branch else { return (None, None) };
    let Ok(full) = gix::refs::FullName::try_from(format!("refs/heads/{branch}")) else { return (None, None) };
    let upstream = repo
        .branch_remote_tracking_ref_name(full.as_ref(), gix::remote::Direction::Fetch)
        .and_then(Result::ok)
        .map(|name| name.as_ref().shorten().to_string());
    let remote_name = upstream
        .as_ref()
        .and_then(|_| repo.branch_remote_name(branch, gix::remote::Direction::Fetch))
        .map(|name| name.as_bstr().to_string());
    (upstream, remote_name)
}

fn pull_with_rebase(value: Option<&str>) -> Option<bool> {
    match value {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

/// `<git 目录>/FETCH_HEAD`（每个工作树各一份，Desktop 用 resolvedGitDir）；读不到就是从没拉取过
fn fetch_head(git_dir: &Path) -> Option<FetchHead> {
    let metadata = std::fs::metadata(git_dir.join("FETCH_HEAD")).ok()?;
    let modified = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(FetchHead { modified_ms: modified.as_secs_f64() * 1000.0, empty: metadata.len() == 0 })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub is_current: bool,
}

/// 本地分支列表，当前分支排在最前（对齐 Desktop 分支下拉的排序）。
pub fn branches(repo_path: &Path) -> Result<Vec<Branch>, String> {
    let repo = gix::open(repo_path).map_err(|e| format!("打开仓库失败: {e}"))?;
    let current = repo.head_name().ok().flatten().map(|n| n.shorten().to_string());

    let refs = repo.references().map_err(|e| format!("读引用失败: {e}"))?;
    let mut out: Vec<Branch> = refs
        .local_branches()
        .map_err(|e| format!("列出分支失败: {e}"))?
        .filter_map(Result::ok)
        .map(|r| {
            let name = r.name().shorten().to_string();
            let is_current = Some(&name) == current.as_ref();
            Branch { name, is_current }
        })
        .collect();
    out.sort_by(|a, b| b.is_current.cmp(&a.is_current).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// 相对上游的领先/落后提交数。
///
/// 领先 / 落后上游几个提交。没有上游、上游分支已不存在或 HEAD 未诞生都算「未发布」。
///
/// 等价于 `git rev-list --left-right --count HEAD...@{upstream}`，但不起进程：
/// 两次各自以对方为隐藏起点的遍历，走到交汇处就停。
pub(crate) fn ahead_behind(repo: &gix::Repository) -> (bool, u32, u32) {
    let (Ok(head), Ok(upstream)) = (repo.head_id(), repo.rev_parse_single("@{upstream}")) else {
        return (false, 0, 0);
    };
    // 与上游同一个提交（最常见的情形）不必遍历：两边都没有对方没有的提交
    if head.detach() == upstream.detach() {
        return (true, 0, 0);
    }
    let count = |from: gix::ObjectId, hidden: gix::ObjectId| -> Option<u32> {
        let walk = repo.rev_walk([from]).with_hidden([hidden]).all().ok()?;
        let mut total = 0u32;
        for info in walk {
            info.ok()?;
            total += 1;
        }
        Some(total)
    };
    match (count(head.detach(), upstream.detach()), count(upstream.detach(), head.detach())) {
        (Some(ahead), Some(behind)) => (true, ahead, behind),
        _ => (false, 0, 0),
    }
}

/// 一个冲突文件的细节：两边各自还在不在，以及文件里剩几处冲突标记。
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub has_base: bool,
    /// 我们这边（当前分支）还有这个文件吗。false = 我们删了它
    pub has_ours: bool,
    /// 对面（被合进来的那条）还有这个文件吗。false = 对面删了它
    pub has_theirs: bool,
    /// 文件里还剩几处 `<<<<<<<` 之类的标记
    pub markers: u32,
    /// 二进制文件。它没有「冲突标记」可言，数出来的 0 不等于已解决，
    /// 界面上只能给「用哪边的」两个选择。
    pub binary: bool,
}

/// 还带着冲突的路径，以及每个文件的细节。
///
/// 冲突在 index 里的表现是「同一路径有 stage 1/2/3 三条记录」，
/// gix 的 status 迭代器只会把它当成一次普通改动报出来，所以另外读一次 index。
/// 标记数走 `git diff --check`（照原版 getFilesWithConflictMarkers）——
/// 只在真有冲突时才起这个进程，平时一次也不多跑。
/// 冲突文件里哪些是二进制。
///
/// 照原版 getBinaryPaths：`git diff --numstat` 对二进制文件给的是 `-\t-\t路径`。
/// 比的对象要跟着当前操作走——合并比 MERGE_HEAD，变基比 REBASE_HEAD，
/// 其余（比如 stash 引进来的冲突）比 HEAD。
fn binary_conflicts(root: &Path, files: &[String]) -> std::collections::HashSet<String> {
    binary_paths(root, conflict_revision(root), files).unwrap_or_default().into_iter().collect()
}

pub(crate) fn conflict_revision(root: &Path) -> &'static str {
    let git_dir = root.join(".git");
    let re = |f: &str| git_dir.join(f).exists();
    if re("MERGE_HEAD") {
        "MERGE_HEAD"
    } else if re("REBASE_HEAD") {
        "REBASE_HEAD"
    } else {
        "HEAD"
    }
}

/// 冲突文件里哪些是二进制、各有几个冲突标记。先在进程内作答（只算冲突路径，见
/// `raw_diff::in_process::conflict_details`），让位时照原版各起一次 `diff --numstat`、`check-attr`、`diff --check`。
pub(crate) fn conflict_details(
    root: &Path, paths: &[String],
) -> (std::collections::HashSet<String>, std::collections::BTreeMap<String, u32>) {
    #[cfg(unix)]
    if let Ok(details) = crate::raw_diff::in_process::conflict_details(root, conflict_revision(root), paths) {
        return details;
    }
    let binary = binary_conflicts(root, paths);
    let markers = conflict_markers(root).unwrap_or_default();
    (binary, markers)
}

pub fn binary_paths(root: &Path, revision: &str, conflicts: &[String]) -> Result<Vec<String>, String> {
    let output = crate::git::Git::new(Some(root))
        .args(["--no-optional-locks", "diff", "--numstat", "-z", "--end-of-options", revision, "--"])
        .stdout()?;
    let mut paths = Vec::new();
    let mut records = output.split('\0');
    while let Some(record) = records.next() {
        if let Some(path) = record.strip_prefix("-\t-\t") {
            let path = if path.is_empty() {
                records.next();
                records.next().unwrap_or("")
            } else {
                path
            };
            if !path.is_empty() && !paths.iter().any(|p| p == path) {
                paths.push(path.to_string());
            }
        }
    }
    if !conflicts.is_empty() {
        let attrs = crate::git::Git::new(Some(root))
            .args(["check-attr", "--stdin", "-z", "merge"])
            .stdin(conflicts.join("\0"))
            .stdout()?;
        let fields: Vec<_> = attrs.split('\0').collect();
        for group in fields.chunks(3) {
            if let [path, "merge", "binary"] = group
                && !paths.iter().any(|p| p == path)
            {
                paths.push((*path).to_string());
            }
        }
    }
    Ok(paths)
}

/// 子模块的脏法：gix 在遍历状态时顺带算出子模块自己的状态，照 porcelain v2 的
/// `S<c><m><u>` 拆成三项（指向的提交变了 / 内部有改动 / 内部有未跟踪文件）。
fn submodule_flags(status: &gix::submodule::Status) -> Submodule {
    let changes = status.changes.as_deref().unwrap_or_default();
    let untracked = |item: &gix::status::Item| {
        matches!(
            item,
            gix::status::Item::IndexWorktree(gix::status::index_worktree::Item::DirectoryContents { entry, .. })
                if entry.status == gix::dir::entry::Status::Untracked
        )
    };
    Submodule {
        commit_changed: status.checked_out_head_id.is_some() && status.checked_out_head_id != status.index_id,
        modified: changes.iter().any(|item| !untracked(item)),
        untracked: changes.iter().any(untracked),
    }
}

pub(crate) fn conflicts(index: &gix::index::State, root: &Path) -> std::collections::HashMap<String, Conflict> {
    use gix::index::entry::Stage;
    let mut out: std::collections::HashMap<String, Conflict> = std::collections::HashMap::new();
    for e in index.entries() {
        let stage = e.stage();
        if stage == Stage::Unconflicted {
            continue;
        }
        let c = out.entry(e.path(index).to_string()).or_default();
        // stage 2 = 我们这边的版本，stage 3 = 对面的版本。缺哪个就说明那边把
        // 文件删了（modify/delete 冲突），这时「用那边的」= 删掉文件，
        // 而不是 checkout 一个根本不存在的版本。
        match stage {
            Stage::Base => c.has_base = true,
            Stage::Ours => c.has_ours = true,
            Stage::Theirs => c.has_theirs = true,
            _ => {}
        }
    }
    if out.is_empty() {
        return out;
    }
    let (binary, markers) = conflict_details(root, &out.keys().cloned().collect::<Vec<_>>());
    for (path, c) in out.iter_mut() {
        c.binary = binary.contains(path);
    }
    for (path, count) in markers {
        if let Some(conflict) = out.get_mut(&path) {
            conflict.markers = count;
        }
    }
    out
}

/// 打开仓库，相对的 `core.excludesFile` 按工作区根目录解析。
///
/// git 读这个文件时已经切到工作区根目录（GitLens integration/gitIgnoreFilter「resolves a relative
/// core.excludesFile from the repository root, as git does」）；gix 把相对路径原样交给文件系统，
/// 落到本进程的工作目录上（打包应用里是 `/`），被它忽略的文件于是出现在未跟踪列表里，
/// 文件监听也不再过滤它们。只在内存里改这一项，不写回配置。
pub fn open_with_excludes(repo_path: &Path) -> Result<gix::Repository, String> {
    let mut repo = gix::open(repo_path).map_err(|e| e.to_string())?;
    let relative = repo.config_snapshot().trusted_path("core.excludesFile").ok().flatten().filter(|f| f.is_relative());
    if let (Some(file), Some(root)) = (relative, repo.workdir().map(Path::to_path_buf)) {
        let absolute = gix::path::into_bstr(root.join(file)).map_err(|e| e.to_string())?;
        let mut config = repo.config_snapshot_mut();
        config.set_value(&gix::config::tree::Core::EXCLUDES_FILE, absolute.as_ref()).map_err(|e| e.to_string())?;
        config.commit().map_err(|e| e.to_string())?;
    }
    Ok(repo)
}

/// gix 状态项按暂存区 / 工作区 / 未跟踪分桶。
#[derive(Default)]
struct Buckets {
    // staged / unstaged 分开收集，最后合并成每个文件一行
    staged: Vec<String>,
    staged_additions: std::collections::HashSet<String>,
    // 工作区里已删除的已跟踪路径。暂存区与工作区两侧的状态项由 gix 并行产出、顺序不定，
    // 「先 add 后删除」不能靠 types 里最后写入的类型判断。
    worktree_removals: std::collections::HashSet<String>,
    unstaged: Vec<String>,
    untracked: Vec<String>,
    // 改动类型另存一份：gix 的状态项里带着它，但上面那三个桶只记路径
    types: std::collections::HashMap<String, ChangeType>,
    old_paths: std::collections::HashMap<String, String>,
    subs: std::collections::HashMap<String, Submodule>,
}

impl Buckets {
    /// 同一路径可能既在暂存区又在工作区出现（kind = both）。两边给的类型不一样时
    /// 保留更具体的那个：工作区那侧只会说「改了」，而「重命名 / 新增 / 删除」的信息
    /// 只有暂存区那侧知道，被覆盖掉就变回了一个普通的「修改」。
    fn note(&mut self, p: &str, c: ChangeType) {
        match self.types.get(p) {
            Some(old) if *old != ChangeType::Modified && c == ChangeType::Modified => {}
            _ => {
                self.types.insert(p.to_string(), c);
            }
        }
    }

    /// 暂存区一侧（HEAD 与索引）的改动。
    fn take_tree(&mut self, changes: Vec<tree_index::Change>) {
        use tree_index::Change as TiChange;
        for change in changes {
            let (path, c) = match change {
                TiChange::Added(path) => {
                    self.staged_additions.insert(path.clone());
                    (path, ChangeType::Added)
                }
                TiChange::Deleted(path) => (path, ChangeType::Deleted),
                TiChange::Rewritten { path, source, copy } => {
                    self.old_paths.insert(path.clone(), source);
                    (path, if copy { ChangeType::Copied } else { ChangeType::Renamed })
                }
                TiChange::Modified(path) => (path, ChangeType::Modified),
            };
            self.note(&path, c);
            self.staged.push(path);
        }
    }

    /// 工作区一侧（索引与工作区，含 gix 自己遍历出的未跟踪文件）的改动。
    fn take_worktree(&mut self, iter: gix::status::index_worktree::Iter) -> Result<(), String> {
        use gix::status::index_worktree::Item as IwItem;
        for item in iter {
            let item = item.map_err(|e| format!("读取状态项失败: {e}"))?;
            let path = item.rela_path().to_string();
            match &item {
                IwItem::DirectoryContents { .. } => {
                    self.note(&path, ChangeType::Added);
                    self.untracked.push(path);
                }
                IwItem::Modification { status, .. } => {
                    use gix::status::plumbing::index_as_worktree::{Change as IwChange, EntryStatus};
                    // 工作区里文件没了 → 删除；其余（内容/权限/类型变化）都算修改
                    let c = match status {
                        EntryStatus::Change(IwChange::Removed) => {
                            self.worktree_removals.insert(path.clone());
                            ChangeType::Deleted
                        }
                        EntryStatus::Change(IwChange::SubmoduleModification(submodule)) => {
                            self.subs.insert(path.clone(), submodule_flags(submodule));
                            ChangeType::Modified
                        }
                        _ => ChangeType::Modified,
                    };
                    self.note(&path, c);
                    self.unstaged.push(path);
                }
                _ => {
                    self.note(&path, ChangeType::Modified);
                    self.unstaged.push(path);
                }
            }
        }
        Ok(())
    }
}

/// 已跟踪文件 lstat 比较的线程数。gix 默认用满全部逻辑核，但 macOS 上并发 lstat 超过 4～6 个线程后
/// 不再变快，内核争用反而让它变慢（分解测量见 docs/benchmarks.md）。
pub(crate) fn tracked_threads() -> usize {
    std::thread::available_parallelism().map_or(1, usize::from).min(6)
}

/// stat 预检的线程数：fstatat / lstat 在 4 个线程时最快（分解测量见 docs/benchmarks.md）。
pub(crate) fn preload_threads() -> usize {
    std::thread::available_parallelism().map_or(1, usize::from).min(4)
}

/// 未跟踪文件遍历的线程数，理由同上：opendir / readdir 超过 4 个线程不再变快。
pub(crate) fn walk_threads() -> usize {
    std::thread::available_parallelism().map_or(1, usize::from).min(4)
}

/// 已跟踪比较与暂存区比较的两个加速开关，测试里关掉它们与 gix 原本的做法对照。
#[derive(Clone, Copy, Debug)]
pub(crate) struct Tuning {
    /// 先按目录 fstatat 预检，stat 相符的条目让 gix 跳过（见 `preload`）
    pub(crate) preload: bool,
    /// HEAD 与索引按 cache-tree 跳过没变的子树（见 `tree_index`）
    pub(crate) cache_tree: bool,
    /// 未跟踪缓存校验记录时用预检取到的目录 lstat（见 `untracked_cache::Prepared::share_dir_stats`）
    pub(crate) share_dir_stats: bool,
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning { preload: true, cache_tree: true, share_dir_stats: true }
    }
}

pub fn status(repo_path: &Path) -> Result<RepoStatus, String> {
    status_tuned(repo_path, Tuning::default())
}

pub(crate) fn status_tuned(repo_path: &Path, tuning: Tuning) -> Result<RepoStatus, String> {
    let repo = open_with_excludes(repo_path).map_err(|e| format!("打开仓库失败: {e}"))?;
    let branch = repo.head_name().ok().flatten().map(|n| n.shorten().to_string());
    let config = repo.config_snapshot();

    // 索引只读一次：已跟踪文件比较、目录遍历与冲突检查共用同一份快照。
    let index = repo.index_or_empty().map_err(|e| format!("读取索引失败: {e}"))?;
    #[cfg(unix)]
    let preload_settings = tuning.preload.then(|| preload::Settings::of(&repo)).transpose()?;
    // 未跟踪缓存的全局签名要在构建忽略规则栈（Walk::new）之前取
    #[cfg(unix)]
    let mut prepared = untracked_cache::prepare(&repo, &index);
    // 预检确认各级目录时取到的 lstat 交给未跟踪缓存校验记录，同一批目录不再 lstat 两遍
    #[cfg(unix)]
    let dir_stats = std::cell::RefCell::new(
        prepared.as_mut().filter(|_| tuning.share_dir_stats && preload_settings.is_some()).map(|p| p.share_dir_stats()),
    );
    // Desktop getStatus 带 `--untracked-files=all`：未跟踪目录里的文件逐个列出，才能单独勾选、查看 diff。
    // 未跟踪文件由并行遍历产出（见 `untracked`），gix 自己的单线程遍历只在并行遍历出错时兜底。
    let tracked_only = |untracked: gix::status::UntrackedFiles| {
        // 先取走发送端：之后任何一步出错或 panic，发送端都随之丢掉，等它的遍历线程不会一直等
        #[cfg(unix)]
        let sender = dir_stats.borrow_mut().take();
        let mut worktree_index: gix::worktree::IndexPersistedOrInMemory = index.clone().into();
        // 先预检 stat：相符的条目不再交给 gix，全部相符时 gix 一个条目也不用看。
        // gix 自己遍历未跟踪文件时要用完整索引判断哪些路径已跟踪，那时不预检。
        #[cfg(unix)]
        let mut dirs = sender.as_ref().map(|_| preload::DirStats::new());
        #[cfg(unix)]
        let preloaded = match (preload_settings, repo.workdir(), untracked) {
            (Some(settings), Some(workdir), gix::status::UntrackedFiles::None) => {
                preload::unresolved_with_dirs(&index, workdir, settings, preload_threads(), dirs.as_mut())
            }
            _ => None,
        };
        // 没预检时丢掉发送端，校验记录的一方自己 lstat
        #[cfg(unix)]
        if let (Some(sender), Some(dirs), Some(_)) = (sender, dirs, &preloaded) {
            let _ = sender.send(dirs);
        }
        #[cfg(unix)]
        if let Some((rest, _)) = preloaded {
            if rest.entries().is_empty() {
                return Ok(None);
            }
            worktree_index = gix::index::File::from_state(rest, repo.index_path()).into();
        }
        repo.status(gix::progress::Discard)
            .map_err(|e| format!("准备 status 失败: {e}"))?
            .index(worktree_index)
            .untracked_files(untracked)
            .index_worktree_options_mut(|options| options.thread_limit = Some(tracked_threads()))
            .into_index_worktree_iter(Vec::new())
            .map(Some)
            .map_err(|e| format!("遍历 status 失败: {e}"))
    };
    let walk = untracked::Walk::new(&repo, &index);

    // 目录遍历与 HEAD–索引比较各在一个工作线程里进行；本线程同时做已跟踪文件的比较（gix 另起线程产出）、
    // 领先/落后、冲突细节等，最后汇合。
    let (mut buckets, walked, conflicted, (has_upstream, ahead, behind)) = std::thread::scope(|scope| {
        let staged = {
            let (repo, index) = (repo.clone(), index.clone());
            scope.spawn(move || {
                if tuning.cache_tree {
                    tree_index::changes(&repo, &index).map(|(changes, _)| changes)
                } else {
                    let head = repo.head_tree_id_or_empty().map_err(|e| format!("读取 HEAD 树失败: {e}"))?;
                    tree_index::via_gix(&repo, &index, head.detach())
                }
            })
        };
        let walker = match walk {
            Ok(walk) => Some(scope.spawn(move || {
                #[cfg(unix)]
                return untracked_cache::untracked(prepared, walk, walk_threads());
                #[cfg(not(unix))]
                walk.run(walk_threads())
            })),
            Err(error) => {
                log::warn!("准备并行遍历未跟踪文件失败，改用 gix 的单线程遍历: {error}");
                None
            }
        };
        let mut buckets = Buckets::default();
        let untracked_mode =
            if walker.is_some() { gix::status::UntrackedFiles::None } else { gix::status::UntrackedFiles::Files };
        let tracked =
            tracked_only(untracked_mode).and_then(|iter| iter.map_or(Ok(()), |iter| buckets.take_worktree(iter)));
        let counts = ahead_behind(&repo);
        let conflicted = conflicts(&index, repo_path);
        let staged = staged.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic));
        let walked = match walker.map(|walker| walker.join()) {
            None => Vec::new(),
            Some(Ok(Ok(files))) => files,
            Some(Ok(Err(error))) => {
                log::warn!("并行遍历未跟踪文件失败，改用 gix 的单线程遍历: {error}");
                let mut buckets = Buckets::default();
                buckets.take_tree(staged?);
                if let Some(iter) = tracked_only(gix::status::UntrackedFiles::Files)? {
                    buckets.take_worktree(iter)?;
                }
                return Ok((buckets, Vec::new(), conflicted, counts));
            }
            Some(Err(panic)) => std::panic::resume_unwind(panic),
        };
        tracked?;
        buckets.take_tree(staged?);
        Ok::<_, String>((buckets, walked, conflicted, counts))
    })?;

    // 未跟踪条目最后记类型：`rm --cached` 后仍在的文件同时有暂存区的删除，它在列表里是新增的未跟踪文件。
    for path in walked {
        buckets.note(&path, ChangeType::Added);
        buckets.untracked.push(path);
    }
    let Buckets { staged, staged_additions, worktree_removals, unstaged, untracked, mut types, mut old_paths, subs } =
        buckets;

    // gix currently misses Git's copy detection for modified sources. Preserve
    // the configured behavior, paying the CLI cost only for explicit copy mode.
    let renames = config.string("status.renames").or_else(|| config.string("diff.renames"));
    if renames.is_some_and(|value| value.eq_ignore_ascii_case(b"copies")) {
        let output = crate::git::Git::new(Some(repo_path))
            .args(["--no-optional-locks", "diff", "--cached", "--raw", "-z", "-C", "--no-ext-diff", "--"])
            .output()?;
        if !output.status.success() {
            return Err(crate::git::stderr_of(&output));
        }
        for file in crate::history::parse_raw_with_numstat(&output.stdout) {
            if file.kind == crate::history::CommitFileKind::Copied {
                types.insert(file.path.clone(), ChangeType::Copied);
                if let Some(old_path) = file.old_path {
                    old_paths.insert(file.path, old_path);
                }
            }
        }
    }
    let mut changes: Vec<FileChange> = Vec::new();
    let type_of = |p: &str, t: &std::collections::HashMap<String, ChangeType>| {
        if conflicted.contains_key(p) {
            return ChangeType::Conflicted;
        }
        t.get(p).copied().unwrap_or(ChangeType::Modified)
    };
    let staged_set: std::collections::HashSet<&str> = staged.iter().map(String::as_str).collect();
    let unstaged_set: std::collections::HashSet<&str> = unstaged.iter().map(String::as_str).collect();
    let untracked_set: std::collections::HashSet<&str> = untracked.iter().map(String::as_str).collect();
    for p in &staged {
        // Desktop 的工作区视图是最终内容：先 add 后删除的新文件没有可提交内容；
        // rm --cached 后仍存在的文件由 untracked 条目表示，不能重复列一条删除。
        if untracked_set.contains(p.as_str()) || (staged_additions.contains(p) && worktree_removals.contains(p)) {
            continue;
        }
        let kind = if unstaged_set.contains(p.as_str()) { ChangeKind::Both } else { ChangeKind::Staged };
        changes.push(FileChange {
            path: p.clone(),
            kind,
            change: type_of(p, &types),
            old_path: old_paths.get(p).cloned(),
            conflict: conflicted.get(p).copied(),
            submodule: subs.get(p).copied(),
        });
    }
    for p in &unstaged {
        if !staged_set.contains(p.as_str()) {
            let change = type_of(p, &types);
            changes.push(FileChange {
                path: p.clone(),
                kind: ChangeKind::Unstaged,
                change,
                old_path: old_paths.get(p).cloned(),
                conflict: conflicted.get(p).copied(),
                submodule: subs.get(p).copied(),
            });
        }
    }
    drop((staged_set, unstaged_set, untracked_set));
    for p in untracked {
        let change = type_of(&p, &types);
        let submodule = subs.get(&p).copied();
        changes.push(FileChange {
            path: p,
            kind: ChangeKind::Untracked,
            change,
            old_path: None,
            conflict: None,
            submodule,
        });
    }
    // Match porcelain ordering: tracked entries first, then unmerged, then untracked.
    let order = |f: &FileChange| {
        if matches!(f.kind, ChangeKind::Untracked) {
            2
        } else if matches!(f.change, ChangeType::Conflicted) {
            1
        } else {
            0
        }
    };
    changes.sort_by(|a, b| order(a).cmp(&order(b)).then_with(|| a.path.cmp(&b.path)));

    let remote = remote_of(&repo, &config, branch.as_deref());

    let (operation, theirs) = match crate::ops::in_progress(repo.path()) {
        Some((op, theirs)) => (Some(op), theirs),
        None => (None, None),
    };

    let unborn = repo.head().map(|head| head.is_unborn()).unwrap_or(false);
    let head = repo.head_id().ok().map(|id| id.to_string());
    let fetch_head = fetch_head(repo.path());
    let pull_rebase = config.string("pull.rebase");
    let pull_with_rebase = pull_with_rebase(pull_rebase.as_ref().and_then(|v| std::str::from_utf8(v).ok()));
    let (upstream, upstream_remote_name) = upstream_of(&repo, branch.as_deref());

    Ok(RepoStatus {
        branch,
        changes,
        remote,
        has_upstream,
        ahead,
        behind,
        operation,
        theirs,
        unborn,
        head,
        fetch_head,
        pull_with_rebase,
        upstream,
        upstream_remote_name,
    })
}

/// Desktop git-store `loadRemotes`: the tracked remote only when it is a configured remote, otherwise the
/// default remote (`findDefaultRemote`: origin, then the first). A local upstream (`.`) is not a remote.
fn remote_of(repo: &gix::Repository, config: &gix::config::Snapshot<'_>, branch: Option<&str>) -> Option<String> {
    let names: Vec<_> = repo.remote_names().into_iter().map(|name| name.to_string()).collect();
    let tracked_remote =
        branch.and_then(|name| config.string(format!("branch.{name}.remote").as_str()).map(|value| value.to_string()));
    tracked_remote
        .filter(|name| names.contains(name))
        .or_else(|| names.iter().find(|name| *name == "origin").cloned())
        .or_else(|| names.first().cloned())
}

/// 待办页用的摘要：分支、远端、领先数和冲突文件。只读引用和索引，不遍历工作区。
///
/// 待办页要把列表里的每个仓库都问一遍。完整 status 带未跟踪文件遍历，几百个仓库一起跑会把
/// CPU 和文件描述符打满（2026-10-30 用户实际使用时 700% CPU、遍历因 readdir 失败逐个退回单线程）。
/// 这里的字段和同一仓库的 `status()` 结果一致，见测试。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub has_upstream: bool,
    pub ahead: u32,
    pub behind: u32,
    /// 未解决冲突的路径，按路径排序
    pub conflicts: Vec<String>,
}

pub fn summary(repo_path: &Path) -> Result<RepoSummary, String> {
    let repo = gix::open(repo_path).map_err(|e| format!("打开仓库失败: {e}"))?;
    let branch = repo.head_name().ok().flatten().map(|n| n.shorten().to_string());
    let config = repo.config_snapshot();
    let index = repo.index_or_empty().map_err(|e| format!("读取索引失败: {e}"))?;
    let (has_upstream, ahead, behind) = ahead_behind(&repo);
    let mut conflicts: Vec<String> = conflicts(&index, repo_path).into_keys().collect();
    conflicts.sort();
    let remote = remote_of(&repo, &config, branch.as_deref());
    Ok(RepoSummary { branch, remote, has_upstream, ahead, behind, conflicts })
}

/// Desktop diff-check.ts: count diagnostic records, not arbitrary file text.
pub fn conflict_markers(root: &Path) -> Result<std::collections::BTreeMap<String, u32>, String> {
    let output = crate::git::Git::new(Some(root)).args(["--no-optional-locks", "diff", "--check"]).output()?;
    if !matches!(output.status.code(), Some(0 | 2)) {
        return Err(crate::git::stderr_of(&output));
    }
    let mut files = std::collections::BTreeMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some(prefix) = line.strip_suffix(": leftover conflict marker") else {
            continue;
        };
        let Some((path, number)) = prefix.rsplit_once(':') else {
            continue;
        };
        if !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) {
            *files.entry(path.into()).or_default() += 1;
        }
    }
    Ok(files)
}

/// 未跟踪文件的目录遍历，按已跟踪目录切分到多个线程。
///
/// gix 的 status 把整个目录遍历放在一个线程里，耗时几乎全是 opendir / readdir 系统调用（Desktop 检出约
/// 900 个目录，单线程遍历是 status 的关键路径）。这里用的是同一个 gix-dir 遍历、同一套分类、忽略规则与
/// 选项（与 `Repository::status` 内部的遍历相同），只是在「含已跟踪文件的目录」处把子树交给别的线程，
/// 从该目录起再遍历一次。
///
/// 这样切分结果不变的前提：只逐个列出未跟踪文件（`Matching`）、不报告忽略项时，gix-dir 不暂存也不折叠
/// 任何条目（`should_hold` 只在折叠模式下成立），一个目录里报出的条目只取决于它自己的子树；忽略规则栈
/// 按路径逐级加载，从子目录起遍历时会沿路把上层的 `.gitignore` 读进来。含已跟踪文件的目录本身既不会被
/// 报出（`emit_tracked` 关闭），也不是嵌套仓库或可折叠的未跟踪目录。
pub(crate) mod untracked {
    use gix::bstr::{BStr, BString, ByteSlice};
    use gix::dir::entry::{Kind, Status};
    use gix::dir::walk::{self, Action, Delegate, ForDeletionMode};
    use std::path::PathBuf;
    use std::sync::{Condvar, Mutex, PoisonError};

    /// 子树里至少有这么多个含已跟踪文件的目录才切出去。每次从子目录起遍历，gix-dir 都要先把工作区根目录
    /// 重新分类一遍（含判断它是不是仓库、读 HEAD），开销约等于读几个目录。
    pub(super) const MIN_DIRECTORIES: usize = 32;
    /// 排进队列的目录有这么多个已跟踪的直接子目录时切片（见 `Task`）。
    pub(super) const PARTITION_CHILDREN: usize = 64;

    /// 路径的父目录（工作区根目录下的条目是空串）。
    fn parent(path: &BStr) -> &BStr {
        path[..path.rfind_byte(b'/').unwrap_or(0)].as_bstr()
    }

    /// 切片时子目录归哪一片（FNV-1a）。
    fn slot_of(path: &BStr, parts: usize) -> usize {
        let hash =
            path.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x100_0000_01b3));
        (hash % parts as u64) as usize
    }

    /// 一个遍历任务：从 `root` 起遍历。`part` 为 `Some((slot, of))` 时是同一个目录切成的第 `slot` 片（共 `of` 片）：
    /// 根下已跟踪的子目录按名字的哈希分给各片，根下的其余直接子项（文件、未跟踪目录、嵌套仓库）只归第 0 片。
    /// 子目录很多、每个都不大的目录（例如几百个各有几十个文件的模块目录）整个交给一个线程会成为关键路径，
    /// 按子树切又要每个子目录重新分类一次根，所以按片切：每片只多读一次根目录、多分类一次根。
    struct Task {
        root: BString,
        part: Option<(usize, usize)>,
    }

    #[derive(Default)]
    struct Queue {
        pending: Vec<Task>,
        active: usize,
        failed: Option<String>,
    }

    struct Shared<'a> {
        queue: Mutex<Queue>,
        ready: Condvar,
        threads: usize,
        min_directories: usize,
        partition_children: usize,
        index: &'a gix::index::State,
    }

    impl Shared<'_> {
        fn lock(&self) -> std::sync::MutexGuard<'_, Queue> {
            self.queue.lock().unwrap_or_else(PoisonError::into_inner)
        }

        fn fail(&self, error: String) {
            self.lock().failed.get_or_insert(error);
            self.ready.notify_all();
        }

        /// 下一个要遍历的任务；全部做完或出错时返回 None。
        fn next(&self) -> Option<Task> {
            let mut queue = self.lock();
            loop {
                if queue.failed.is_some() {
                    return None;
                }
                if let Some(root) = queue.pending.pop() {
                    queue.active += 1;
                    return Some(root);
                }
                if queue.active == 0 {
                    return None;
                }
                queue = self.ready.wait(queue).unwrap_or_else(PoisonError::into_inner);
            }
        }

        /// 索引里 `directory/` 的直接子项中有几个是目录（数到 `cap` 为止）。每个子目录用一次二分跳过。
        fn tracked_child_directories(&self, directory: &BStr, cap: usize) -> usize {
            let mut prefix = directory.to_owned();
            if !prefix.is_empty() {
                prefix.push(b'/');
            }
            let Some(range) = self.index.prefixed_entries_range(prefix.as_ref()) else {
                return 0;
            };
            let entries = self.index.entries();
            let (mut i, mut count) = (range.start, 0);
            while i < range.end && count < cap {
                let path = entries[i].path(self.index);
                let rest = &path[prefix.len()..];
                let Some(slash) = rest.find_byte(b'/') else {
                    i += 1;
                    continue;
                };
                count += 1;
                let mut child = prefix.clone();
                child.extend_from_slice(&rest[..=slash]);
                i = self.index.prefixed_entries_range(child.as_ref()).map_or(i + 1, |r| r.end.max(i + 1));
            }
            count
        }

        /// 把 `directory` 排进队列：子目录够多时切成每个线程一片。
        fn push(&self, directory: BString) {
            let parts = if self.threads > 1
                && self.tracked_child_directories(directory.as_ref(), self.partition_children)
                    >= self.partition_children
            {
                self.threads
            } else {
                1
            };
            let mut queue = self.lock();
            if parts == 1 {
                queue.pending.push(Task { root: directory, part: None });
            } else {
                for slot in 0..parts {
                    queue.pending.push(Task { root: directory.clone(), part: Some((slot, parts)) });
                }
            }
            drop(queue);
            self.ready.notify_all();
        }

        /// 索引里 `directory/` 下面有几个不同的父目录（按排序相邻比较，只作估算）。
        fn tracked_directories_below(&self, directory: &BStr) -> usize {
            let mut prefix = directory.to_owned();
            prefix.push(b'/');
            let Some(range) = self.index.prefixed_entries_range(prefix.as_ref()) else {
                return 0;
            };
            let parent = |entry: &gix::index::Entry| {
                let path = entry.path(self.index);
                &path[..path.rfind_byte(b'/').unwrap_or(0)]
            };
            let entries = &self.index.entries()[range];
            let mut count = 0;
            let mut previous: Option<&[u8]> = None;
            for entry in entries {
                let current = parent(entry);
                if previous != Some(current) {
                    count += 1;
                    if count >= self.min_directories {
                        break;
                    }
                }
                previous = Some(current);
            }
            count
        }
    }

    /// 一次遍历实际读过的目录（含遍历根，各带进入前 `probe` 的结果）与报出的嵌套仓库，
    /// 供未跟踪缓存记录（见 `untracked_cache`）。
    pub(crate) struct Visits<P> {
        pub(crate) dirs: Vec<(BString, P)>,
        pub(crate) repositories: Vec<String>,
    }

    impl<P> Default for Visits<P> {
        fn default() -> Self {
            Visits { dirs: Vec::new(), repositories: Vec::new() }
        }
    }

    /// 进入目录、读它之前对它做的检查（未跟踪缓存在这里取目录的 stat 签名）。
    pub(crate) type Probe<'a, P> = &'a (dyn Fn(&BStr) -> P + Sync);

    struct Split<'a, P> {
        root: &'a BStr,
        part: Option<(usize, usize)>,
        shared: &'a Shared<'a>,
        found: Vec<String>,
        probe: Option<Probe<'a, P>>,
        visits: Visits<P>,
    }

    impl<P> Delegate for Split<'_, P> {
        fn emit(&mut self, entry: gix::dir::EntryRef<'_>, _collapsed: Option<Status>) -> Action {
            // 切片时根下的直接子项只由第 0 片报出（其余各片不进去的未跟踪目录也会被当作条目报到这里）
            if self.part.is_some_and(|(slot, _)| slot != 0) && parent(entry.rela_path.as_ref()) == self.root {
                return Action::Continue(());
            }
            // 与 gix status 的遍历委托相同：不可跟踪的类型（套接字、FIFO 等）不报
            if entry.disk_kind != Some(Kind::Untrackable) {
                if entry.disk_kind == Some(Kind::Repository) {
                    self.visits.repositories.push(entry.rela_path.to_string());
                }
                self.found.push(entry.rela_path.to_string());
            }
            Action::Continue(())
        }

        fn can_recurse(
            &mut self, entry: gix::dir::EntryRef<'_>, for_deletion: Option<ForDeletionMode>,
            worktree_root_is_repository: bool,
        ) -> bool {
            let recurse = entry.status.can_recurse(
                entry.disk_kind,
                entry.pathspec_match,
                for_deletion,
                worktree_root_is_repository,
            );
            let path = entry.rela_path.as_ref();
            let tracked_dir = recurse && entry.status == Status::Tracked && entry.disk_kind == Some(Kind::Directory);
            if let Some((slot, parts)) = self.part {
                if path == self.root {
                    // 根目录只由第 0 片记录
                    if slot != 0 {
                        return recurse;
                    }
                } else if parent(path) == self.root {
                    let owner = if tracked_dir { slot_of(path, parts) } else { 0 };
                    if owner != slot {
                        return false;
                    }
                }
            }
            if tracked_dir
                && path != self.root
                // 队列里已经够所有线程忙的，就在本线程接着走
                && self.shared.lock().pending.len() < self.shared.threads * 2
                && self.shared.tracked_directories_below(path) >= self.shared.min_directories
            {
                self.shared.push(entry.rela_path.into_owned());
                return false;
            }
            if recurse && let Some(probe) = self.probe {
                let checked = probe(entry.rela_path.as_ref());
                self.visits.dirs.push((entry.rela_path.into_owned(), checked));
            }
            recurse
        }
    }

    /// 遍历所需的一切，在打开仓库的线程上备好，之后可以交给别的线程运行。
    pub(crate) struct Walk<'index> {
        index: &'index gix::index::State,
        workdir: PathBuf,
        git_dir_realpath: PathBuf,
        current_dir: PathBuf,
        options: walk::Options<'static>,
        excludes: gix::worktree::Stack,
        pathspec: gix::pathspec::Search,
        objects: gix::OdbHandle,
        /// 见 [`MIN_DIRECTORIES`]；测试里设成 1，让每个含已跟踪文件的目录都切出去。
        pub(super) min_directories: usize,
        /// 见 [`PARTITION_CHILDREN`]；测试里设成 1，让每个排进队列的目录都切片。
        pub(super) partition_children: usize,
    }

    impl<'index> Walk<'index> {
        pub(crate) fn new(repo: &gix::Repository, index: &'index gix::index::State) -> Result<Self, String> {
            let err = |e: gix::Error| e.to_string();
            let options = repo.dirwalk_options().map_err(err)?.emit_untracked(walk::EmissionMode::Matching).into();
            let excludes = repo
                .excludes(index, None, gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped)
                .map_err(err)?
                .detach();
            let (pathspec, _) = repo
                .pathspec(
                    false,
                    Vec::<BString>::new(),
                    true,
                    index,
                    gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping,
                )
                .map_err(err)?
                .into_parts();
            let git_dir_realpath =
                gix::path::realpath_opts(repo.git_dir(), repo.current_dir(), gix::path::realpath::MAX_SYMLINKS)
                    .map_err(|e| e.to_string())?;
            Ok(Walk {
                index,
                workdir: repo.workdir().ok_or("没有工作区")?.to_owned(),
                git_dir_realpath,
                current_dir: repo.current_dir().to_owned(),
                options,
                excludes,
                pathspec,
                objects: repo.objects.clone(),
                min_directories: MIN_DIRECTORIES,
                partition_children: PARTITION_CHILDREN,
            })
        }

        /// 工作区里所有未跟踪文件的路径：与 gix status 的 `DirectoryContents` 条目相同的集合，无序。
        pub(crate) fn run(self, threads: usize) -> Result<Vec<String>, String> {
            self.run_visits::<()>(threads, None).map(|(found, _)| found)
        }

        /// 只从 `root`（工作区相对路径）起单线程遍历一次，由 `delegate` 决定进不进子目录。
        /// 未跟踪缓存用它重读变了的目录；`accelerate` 是忽略大小写时的索引查找表。
        pub(crate) fn walk_at(
            &mut self, accelerate: Option<&gix::index::AccelerateLookup<'_>>, root: &BStr, delegate: &mut dyn Delegate,
        ) -> Result<(), String> {
            let traversal_root = self.workdir.join(gix::path::from_bstr(root).map_err(|e| e.to_string())?);
            gix::dir::walk(
                &self.workdir,
                walk::Context {
                    should_interrupt: None,
                    git_dir_realpath: &self.git_dir_realpath,
                    current_dir: &self.current_dir,
                    index: self.index,
                    ignore_case_index_lookup: accelerate,
                    pathspec: &mut self.pathspec,
                    pathspec_attributes: &mut |_, _, _, _| false,
                    excludes: Some(&mut self.excludes),
                    objects: &self.objects,
                    explicit_traversal_root: Some(&traversal_root),
                },
                self.options,
                delegate,
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        }

        pub(crate) fn index(&self) -> &'index gix::index::State {
            self.index
        }

        pub(crate) fn ignore_case(&self) -> bool {
            self.options.ignore_case
        }

        /// 同 [`run`](Self::run)；给了 `probe` 时另外交出读过的目录（各带读之前的检查结果）与嵌套仓库。
        pub(crate) fn run_visits<P: Send>(
            self, threads: usize, probe: Option<Probe<'_, P>>,
        ) -> Result<(Vec<String>, Visits<P>), String> {
            let threads = threads.max(1);
            let Walk {
                index,
                workdir,
                git_dir_realpath,
                current_dir,
                options,
                excludes,
                pathspec,
                objects,
                min_directories,
                partition_children,
            } = self;
            let accelerate = options.ignore_case.then(|| index.prepare_icase_backing());
            let shared = Shared {
                queue: Mutex::new(Queue {
                    pending: vec![Task { root: BString::default(), part: None }],
                    ..Queue::default()
                }),
                ready: Condvar::new(),
                threads,
                min_directories,
                partition_children,
                index,
            };
            let found = Mutex::new(Vec::new());
            let visits = Mutex::new(Visits::<P>::default());
            let (workdir, git_dir_realpath, current_dir) = (&workdir, &git_dir_realpath, &current_dir);
            std::thread::scope(|scope| {
                for _ in 0..threads {
                    let (shared, found, visits, accelerate) = (&shared, &found, &visits, accelerate.as_ref());
                    let objects = objects.clone();
                    let mut excludes = excludes.clone();
                    let mut pathspec = pathspec.clone();
                    scope.spawn(move || {
                        while let Some(Task { root, part }) = shared.next() {
                            let traversal_root = match gix::path::from_bstr(root.as_bstr()) {
                                Ok(relative) => workdir.join(relative),
                                Err(e) => {
                                    shared.fail(e.to_string());
                                    return;
                                }
                            };
                            let mut delegate = Split {
                                root: root.as_bstr(),
                                part,
                                shared,
                                found: Vec::new(),
                                probe,
                                visits: Visits::default(),
                            };
                            let result = gix::dir::walk(
                                workdir,
                                walk::Context {
                                    should_interrupt: None,
                                    git_dir_realpath,
                                    current_dir,
                                    index,
                                    ignore_case_index_lookup: accelerate,
                                    pathspec: &mut pathspec,
                                    // 没有路径规格，不会查属性
                                    pathspec_attributes: &mut |_, _, _, _| false,
                                    excludes: Some(&mut excludes),
                                    objects: &objects,
                                    explicit_traversal_root: Some(&traversal_root),
                                },
                                options,
                                &mut delegate,
                            );
                            found.lock().unwrap_or_else(PoisonError::into_inner).append(&mut delegate.found);
                            {
                                let mut visits = visits.lock().unwrap_or_else(PoisonError::into_inner);
                                visits.dirs.append(&mut delegate.visits.dirs);
                                visits.repositories.append(&mut delegate.visits.repositories);
                            }
                            if let Err(e) = result {
                                shared.fail(e.to_string());
                            }
                            shared.lock().active -= 1;
                            shared.ready.notify_all();
                        }
                    });
                }
            });
            if let Some(failed) = shared.queue.into_inner().unwrap_or_else(PoisonError::into_inner).failed {
                return Err(failed);
            }
            Ok((
                found.into_inner().unwrap_or_else(PoisonError::into_inner),
                visits.into_inner().unwrap_or_else(PoisonError::into_inner),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(r: &Path, args: &[&str]) -> String {
        let o = Command::new("git").arg("-C").arg(r).args(args).output().unwrap();
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    /// Desktop TipState.Unborn 与 git-store updateLastFetched：没有提交时是 unborn；FETCH_HEAD 在
    /// 拉取之后出现，取它的修改时间，空文件标出来；链接工作树读自己 git 目录里的那份
    #[test]
    fn 未诞生分支与上次拉取() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path().join("repo");
        std::fs::create_dir(&r).unwrap();
        git(&r, &["init", "-q", "-b", "main"]);
        let fresh = status(&r).unwrap();
        assert!(fresh.unborn);
        assert!(fresh.fetch_head.is_none());
        git(
            &r,
            &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"],
        );
        let born = status(&r).unwrap();
        assert!(!born.unborn);
        assert_eq!(born.head.as_deref(), Some(git(&r, &["rev-parse", "HEAD"]).trim()));
        assert!(fresh.head.is_none());
        let upstream = dir.path().join("upstream.git");
        git(&r, &["clone", "-q", "--bare", ".", upstream.to_str().unwrap()]);
        git(&r, &["remote", "add", "origin", upstream.to_str().unwrap()]);
        git(&r, &["fetch", "-q", "origin"]);
        let fetched = status(&r).unwrap().fetch_head.expect("FETCH_HEAD after fetch");
        assert!(!fetched.empty);
        let mtime = std::fs::metadata(r.join(".git/FETCH_HEAD")).unwrap().modified().unwrap();
        let expected = mtime.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0;
        assert_eq!(fetched.modified_ms, expected);
        std::fs::write(r.join(".git/FETCH_HEAD"), "").unwrap();
        assert!(status(&r).unwrap().fetch_head.unwrap().empty);
        assert_eq!(status(&r).unwrap().pull_with_rebase, None);
        for (value, expected) in [("true", Some(true)), ("false", Some(false)), ("merges", None)] {
            git(&r, &["config", "pull.rebase", value]);
            assert_eq!(status(&r).unwrap().pull_with_rebase, expected, "pull.rebase={value}");
        }
        let linked = dir.path().join("linked");
        git(&r, &["worktree", "add", "-q", "-b", "linked", linked.to_str().unwrap()]);
        assert!(status(&linked).unwrap().fetch_head.is_none(), "链接工作树还没拉取过");
    }

    /// Desktop getBranches 的 `%(upstream:short)` / `%(upstream:remotename)`：跟 git 自己算的一致，
    /// 上游名与本地不同、跟踪引用已不存在（gone）时也照配置给出
    #[test]
    fn 上游分支名与远端名() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path().join("repo");
        std::fs::create_dir(&r).unwrap();
        git(&r, &["init", "-q", "-b", "main"]);
        git(
            &r,
            &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"],
        );
        let none = status(&r).unwrap();
        assert_eq!((none.upstream, none.upstream_remote_name), (None, None));
        let remote = dir.path().join("remote.git");
        git(&r, &["clone", "-q", "--bare", ".", remote.to_str().unwrap()]);
        git(&r, &["remote", "add", "upstream", remote.to_str().unwrap()]);
        git(&r, &["push", "-q", "upstream", "main:other"]);
        git(&r, &["fetch", "-q", "upstream"]);
        git(&r, &["branch", "-q", "--set-upstream-to=upstream/other"]);
        let expected = |field: &str| {
            let out = git(&r, &["for-each-ref", &format!("--format=%(upstream:{field})"), "refs/heads/main"]);
            Some(out.trim().to_string())
        };
        let tracked = status(&r).unwrap();
        assert_eq!(tracked.upstream, expected("short"));
        assert_eq!(tracked.upstream.as_deref(), Some("upstream/other"));
        assert_eq!(tracked.upstream_remote_name, expected("remotename"));
        git(&r, &["update-ref", "-d", "refs/remotes/upstream/other"]);
        let gone = status(&r).unwrap();
        assert!(!gone.has_upstream);
        assert_eq!(gone.upstream.as_deref(), Some("upstream/other"));
    }

    #[test]
    fn 摘要与完整_status_的分支_远端_领先与冲突一致() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        git(r, &["init", "-q", "-b", "main"]);
        git(r, &["config", "user.email", "t@example.com"]);
        git(r, &["config", "user.name", "t"]);
        std::fs::write(r.join("a.txt"), "base\n").unwrap();
        git(r, &["add", "."]);
        git(r, &["commit", "-qm", "base"]);
        // 远端：克隆自己当上游，再在本地多提交一次 → 领先 1
        let upstream = dir.path().join("upstream.git");
        git(r, &["clone", "-q", "--bare", ".", upstream.to_str().unwrap()]);
        git(r, &["remote", "add", "origin", upstream.to_str().unwrap()]);
        git(r, &["fetch", "-q", "origin"]);
        git(r, &["branch", "-u", "origin/main"]);
        // 冲突：两条分支改同一行后合并
        git(r, &["checkout", "-qb", "other"]);
        std::fs::write(r.join("a.txt"), "theirs\n").unwrap();
        git(r, &["commit", "-qam", "theirs"]);
        git(r, &["checkout", "-q", "main"]);
        std::fs::write(r.join("a.txt"), "ours\n").unwrap();
        git(r, &["commit", "-qam", "ours"]);
        std::fs::write(r.join("untracked.txt"), "x\n").unwrap();
        let _ = Command::new("git").arg("-C").arg(r).args(["merge", "other"]).output().unwrap();

        let full = status(r).unwrap();
        let light = summary(r).unwrap();
        assert_eq!(light.branch.as_deref(), Some("main"));
        assert_eq!(light.branch, full.branch);
        assert_eq!(light.remote.as_deref(), Some("origin"));
        assert_eq!(light.remote, full.remote);
        assert!(light.has_upstream && full.has_upstream);
        assert_eq!((light.ahead, light.behind), (1, 0));
        assert_eq!((light.ahead, light.behind), (full.ahead, full.behind));
        let mut expected: Vec<_> =
            full.changes.iter().filter(|c| c.change == ChangeType::Conflicted).map(|c| c.path.clone()).collect();
        expected.sort();
        assert_eq!(light.conflicts, vec!["a.txt".to_string()]);
        assert_eq!(light.conflicts, expected);
        // 未跟踪文件不是摘要的事：它只出现在完整 status 里
        assert!(full.changes.iter().any(|c| c.path == "untracked.txt"));
    }

    #[test]
    fn 子模块的三种脏法分得开() {
        let (_d, outer) = crate::test_repo::with_submodule();
        let s = status(&outer).unwrap();
        let c = s.changes.iter().find(|c| c.path == "mod").expect("应列出子模块");
        let sub = c.submodule.expect("应认出这是子模块");
        assert!(sub.commit_changed, "指向的提交变了");
        assert!(sub.modified, "内部有已跟踪文件的改动");
        assert!(sub.untracked, "内部有未跟踪文件");
    }

    #[test]
    fn 二进制冲突不去数标记() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        // 带 NUL 字节，git 会判成二进制
        std::fs::write(r.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "init"]);
        git(&r, &["switch", "-qc", "他们"]);
        std::fs::write(r.join("bin.dat"), [0u8, 9, 9, 9]).unwrap();
        git(&r, &["commit", "-qam", "他们改的"]);
        git(&r, &["switch", "-q", "main"]);
        std::fs::write(r.join("bin.dat"), [0u8, 7, 7, 7]).unwrap();
        git(&r, &["commit", "-qam", "我们改的"]);
        git(&r, &["merge", "他们"]);

        let s = status(&r).unwrap();
        let c = s.changes.iter().find(|c| c.path == "bin.dat").unwrap();
        let d = c.conflict.expect("应是冲突");
        assert!(d.binary, "二进制文件要标出来，它的 0 处标记不代表已解决");
    }

    #[test]
    fn 冲突文件单独成一类并数出标记数() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        std::fs::write(r.join("a.txt"), "原文\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "init"]);
        git(&r, &["switch", "-qc", "别的分支"]);
        std::fs::write(r.join("a.txt"), "他们改的\n").unwrap();
        git(&r, &["commit", "-qam", "他们"]);
        git(&r, &["switch", "-q", "main"]);
        std::fs::write(r.join("a.txt"), "我们改的\n").unwrap();
        git(&r, &["commit", "-qam", "我们"]);
        git(&r, &["merge", "别的分支"]);

        let s = status(&r).unwrap();
        let c = s.changes.iter().find(|c| c.path == "a.txt").expect("应列出冲突文件");
        assert_eq!(c.change, ChangeType::Conflicted, "冲突不能画成普通的「修改」");
        let d = c.conflict.expect("冲突文件应带细节");
        assert!(d.markers > 0, "文件里还有冲突标记，应该数出来");
        assert!(d.has_ours && d.has_theirs, "两边都还在（都改了同一个文件）");

        // 改干净之后标记数归零（原版这时把图标换成勾）
        std::fs::write(r.join("a.txt"), "两边合起来\n").unwrap();
        let s = status(&r).unwrap();
        let c = s.changes.iter().find(|c| c.path == "a.txt").unwrap();
        assert_eq!(c.change, ChangeType::Conflicted, "还没 add，index 里仍是冲突状态");
        assert_eq!(c.conflict.unwrap().markers, 0, "标记删干净了就该归零");
    }

    #[cfg(unix)]
    #[test]
    fn 冲突标记支持带冒号的文件名() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.name", "test"]);
        git(root, &["config", "user.email", "test@example.invalid"]);
        let file = "report:2026.txt";
        std::fs::write(root.join(file), "base\n").unwrap();
        git(root, &["add", "--", file]);
        git(root, &["commit", "-qm", "base"]);
        git(root, &["branch", "side"]);
        std::fs::write(root.join(file), "ours\n").unwrap();
        git(root, &["commit", "-qam", "ours"]);
        git(root, &["checkout", "-q", "side"]);
        std::fs::write(root.join(file), "theirs\n").unwrap();
        git(root, &["commit", "-qam", "theirs"]);
        git(root, &["merge", "main"]);
        assert_eq!(conflict_markers(root).unwrap().get(file), Some(&3));
        let result = status(root).unwrap();
        assert_eq!(result.changes.iter().find(|f| f.path == file).unwrap().conflict.unwrap().markers, 3);
    }

    #[test]
    fn 四种改动类型各自可辨认() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        std::fs::write(r.join("改的.txt"), "1\n2\n").unwrap();
        std::fs::write(r.join("删的.txt"), "x\n").unwrap();
        // 重命名要靠相似度检测认出来，内容太短会被当成「删一个加一个」
        std::fs::write(r.join("旧名.txt"), "内容要足够长才会被认成重命名\n".repeat(10)).unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "init"]);

        std::fs::write(r.join("改的.txt"), "1\n2改\n").unwrap();
        std::fs::remove_file(r.join("删的.txt")).unwrap();
        git(&r, &["mv", "旧名.txt", "新名.txt"]);
        std::fs::write(r.join("新增的.txt"), "新\n").unwrap();

        let s = status(&r).unwrap();
        let of =
            |p: &str| s.changes.iter().find(|c| c.path == p).unwrap_or_else(|| panic!("缺少 {p}: {:?}", s.changes));
        assert_eq!(of("改的.txt").change, ChangeType::Modified);
        assert_eq!(of("删的.txt").change, ChangeType::Deleted);
        assert_eq!(of("新增的.txt").change, ChangeType::Added);
        assert_eq!(of("新增的.txt").kind, ChangeKind::Untracked);
        assert_eq!(of("新名.txt").change, ChangeType::Renamed, "重命名应被识别，而不是当成修改");
        assert_eq!(of("新名.txt").old_path.as_deref(), Some("旧名.txt"), "要能说出旧名字");
    }

    /// GitLens gitIgnoreFilter「resolves a relative core.excludesFile from the repository root, as git does」：
    /// 测试进程的工作目录不是仓库根目录，相对路径若按进程目录解析就读不到规则。
    #[test]
    fn 相对的_core_excludes_file_按仓库根目录解析() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "core.excludesFile", "rel-excludes"]);
        std::fs::write(r.join("rel-excludes"), "*.rel\n").unwrap();
        std::fs::write(r.join("a.rel"), "x\n").unwrap();
        assert_eq!(git(&r, &["status", "--porcelain"]), "?? rel-excludes\n", "git 的判定");

        let paths: Vec<_> = status(&r).unwrap().changes.into_iter().map(|c| c.path).collect();
        assert_eq!(paths, ["rel-excludes"], "被相对 excludesFile 忽略的文件不应列为未跟踪");
    }

    /// GitLens integration/status「untracked: 'all' (and the default) list the file inside the untracked
    /// directory」与 Desktop getStatus 的 `--untracked-files=all`：未跟踪目录不折叠成一条。
    #[test]
    fn 未跟踪目录里的文件逐个列出() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        std::fs::create_dir(r.join("dir")).unwrap();
        std::fs::write(r.join("dir").join("a.txt"), "x\n").unwrap();
        assert_eq!(git(&r, &["status", "--porcelain", "--untracked-files=all"]), "?? dir/a.txt\n", "git 的判定");

        let paths: Vec<_> = status(&r).unwrap().changes.into_iter().map(|c| c.path).collect();
        assert_eq!(paths, ["dir/a.txt"], "未跟踪目录应逐个列出其中的文件");
    }

    #[cfg(unix)]
    type ConflictDetails = (std::collections::HashSet<String>, std::collections::BTreeMap<String, u32>);

    /// 冲突细节的进程内结果对照原版的三条 git 命令（只比冲突路径）；快速路径让位时返回原因。
    #[cfg(unix)]
    fn compare_conflict_details(root: &Path) -> Result<ConflictDetails, String> {
        let index = git(root, &["ls-files", "-u", "-z"]);
        let mut paths: Vec<String> =
            index.split('\0').filter_map(|record| record.split_once('\t').map(|(_, path)| path.to_string())).collect();
        paths.sort();
        paths.dedup();
        assert!(!paths.is_empty(), "夹具应有冲突");
        let revision = conflict_revision(root);
        let fast = crate::raw_diff::in_process::conflict_details(root, revision, &paths)?;
        let binary: std::collections::HashSet<String> =
            binary_paths(root, revision, &paths).unwrap().into_iter().filter(|path| paths.contains(path)).collect();
        let markers: std::collections::BTreeMap<String, u32> =
            conflict_markers(root).unwrap().into_iter().filter(|(path, _)| paths.contains(path)).collect();
        assert_eq!(fast.0, binary, "二进制判定与 git 不同");
        assert_eq!(fast.1, markers, "冲突标记数与 git 不同");
        Ok(fast)
    }

    #[cfg(unix)]
    fn conflict_repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().join("repo");
        std::fs::create_dir_all(&r).unwrap();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        (d, r)
    }

    #[cfg(unix)]
    fn write_all(r: &Path, files: &[(&str, &[u8])]) {
        for (path, data) in files {
            let path = r.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, data).unwrap();
        }
    }

    #[cfg(unix)]
    fn commit_all(r: &Path, message: &str) {
        git(r, &["add", "-A"]);
        git(r, &["commit", "-qm", message]);
    }

    /// base → main（ours）与 side（theirs）各改一遍再合并，返回仓库
    #[cfg(unix)]
    fn merge_conflict(
        base: &[(&str, &[u8])], ours: &[(&str, &[u8])], theirs: &[(&str, &[u8])], attributes: &str,
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let (d, r) = conflict_repo();
        if !attributes.is_empty() {
            write_all(&r, &[(".gitattributes", attributes.as_bytes())]);
        }
        write_all(&r, base);
        commit_all(&r, "base");
        git(&r, &["checkout", "-q", "-b", "side"]);
        write_all(&r, theirs);
        commit_all(&r, "theirs");
        git(&r, &["checkout", "-q", "main"]);
        write_all(&r, ours);
        commit_all(&r, "ours");
        git(&r, &["merge", "-q", "side"]);
        (d, r)
    }

    #[cfg(unix)]
    #[test]
    fn 冲突细节_进程内与_git_一致() {
        let lines =
            |tag: &str| -> Vec<u8> { (1..=30).map(|i| format!("{tag} {i}\n")).collect::<String>().into_bytes() };
        let base = lines("line");
        let edit = |n: &[usize], tag: &str| -> Vec<u8> {
            (1..=30)
                .map(|i| if n.contains(&i) { format!("{tag} {i}\n") } else { format!("line {i}\n") })
                .collect::<String>()
                .into_bytes()
        };
        let ours_one = edit(&[5], "ours");
        let theirs_one = edit(&[5], "theirs");
        let ours_many = edit(&[3, 15, 27], "ours");
        let theirs_many = edit(&[3, 15, 27], "theirs");
        let with_markers_base: Vec<u8> = b"a\n=======\nb\n".to_vec();
        let crlf_base = String::from_utf8(base.clone()).unwrap().replace('\n', "\r\n").into_bytes();
        let crlf_ours = String::from_utf8(ours_one.clone()).unwrap().replace('\n', "\r\n").into_bytes();
        let crlf_theirs = String::from_utf8(theirs_one.clone()).unwrap().replace('\n', "\r\n").into_bytes();
        let (_d, r) = merge_conflict(
            &[
                ("one.txt", &base),
                ("many.txt", &base),
                ("pre-existing.txt", &with_markers_base),
                ("crlf.txt", &crlf_base),
                ("no-eol.txt", b"x"),
                ("bin.dat", b"\0base"),
                ("text-vs-bin.txt", b"text\n"),
                ("attr.merge", b"base\n"),
                ("dir/中文 文件.txt", &base),
                ("report:2026.txt", &base),
                ("modify-delete.txt", &base),
                ("delete-modify.txt", &base),
            ],
            &[
                ("one.txt", &ours_one),
                ("many.txt", &ours_many),
                ("pre-existing.txt", b"a\n=======\nours\n"),
                ("crlf.txt", &crlf_ours),
                ("no-eol.txt", b"ours"),
                ("bin.dat", b"\0ours"),
                ("text-vs-bin.txt", b"ours text\n"),
                ("attr.merge", b"ours\n"),
                ("dir/中文 文件.txt", &ours_one),
                ("report:2026.txt", &ours_one),
                ("modify-delete.txt", &ours_one),
                ("add-add.txt", b"ours add\n"),
            ],
            &[
                ("one.txt", &theirs_one),
                ("many.txt", &theirs_many),
                ("pre-existing.txt", b"a\n=======\ntheirs\n"),
                ("crlf.txt", &crlf_theirs),
                ("no-eol.txt", b"theirs"),
                ("bin.dat", b"\0theirs"),
                ("text-vs-bin.txt", b"\0theirs bin\n"),
                ("attr.merge", b"theirs\n"),
                ("dir/中文 文件.txt", &theirs_one),
                ("report:2026.txt", &theirs_one),
                ("delete-modify.txt", &theirs_one),
                ("add-add.txt", b"theirs add\n"),
            ],
            "*.merge merge=binary\n",
        );
        // modify/delete 与 delete/modify 都在工作区留下改动的一侧；delete/modify 没有 stage 2
        assert!(r.join("modify-delete.txt").exists() && r.join("delete-modify.txt").exists());
        let (binary, markers) = compare_conflict_details(&r).unwrap();
        // 夹具确实覆盖到了：有标记、有内容判定的二进制、有 merge=binary
        assert_eq!(markers.get("one.txt"), Some(&3));
        assert_eq!(markers.get("many.txt"), Some(&9));
        assert_eq!(markers.get("pre-existing.txt"), Some(&3), "{markers:?}");
        for path in ["bin.dat", "text-vs-bin.txt", "attr.merge"] {
            assert!(binary.contains(path), "{path}: {binary:?}");
        }
        assert!(!binary.contains("one.txt"));

        // 部分解决：删掉一组标记、在不完整的末行留一个标记、手写一个带 CR 的标记
        let one = std::fs::read_to_string(r.join("one.txt")).unwrap();
        let mut partly: String = one.lines().filter(|l| !l.starts_with("=======")).map(|l| format!("{l}\n")).collect();
        partly.push_str(">>>>>>>");
        std::fs::write(r.join("one.txt"), partly).unwrap();
        let many = std::fs::read_to_string(r.join("many.txt")).unwrap();
        std::fs::write(r.join("many.txt"), many.replacen("=======\n", "=======\r\n", 1) + "|||||||\n<<<<<<<x\n")
            .unwrap();
        std::fs::write(r.join("no-eol.txt"), "<<<<<<<").unwrap();
        compare_conflict_details(&r).unwrap();

        // 全部解决（内容回到 ours）
        std::fs::write(r.join("one.txt"), &ours_one).unwrap();
        compare_conflict_details(&r).unwrap();

        // 让位：工作区缺文件、conflict-marker-size
        std::fs::remove_file(r.join("one.txt")).unwrap();
        let paths = vec!["one.txt".to_string()];
        assert!(crate::raw_diff::in_process::conflict_details(&r, "MERGE_HEAD", &paths).is_err());
        std::fs::write(r.join("one.txt"), &ours_one).unwrap();
        std::fs::write(r.join(".git/info/attributes"), "one.txt conflict-marker-size=10\n").unwrap();
        assert!(crate::raw_diff::in_process::conflict_details(&r, "MERGE_HEAD", &paths).is_err());
        std::fs::remove_file(r.join(".git/info/attributes")).unwrap();
        // 属性来自 info/attributes 与宏
        std::fs::write(r.join(".git/info/attributes"), "[attr]bin-merge merge=binary\nmany.txt bin-merge\n").unwrap();
        compare_conflict_details(&r).unwrap();
        std::fs::write(r.join(".git/info/attributes"), "*.merge -merge\n").unwrap();
        compare_conflict_details(&r).unwrap();
        std::fs::write(r.join(".git/info/attributes"), "*.merge !merge\nmany.txt merge=text\n").unwrap();
        compare_conflict_details(&r).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn 冲突细节_变基与贮藏冲突() {
        // 变基：比较 REBASE_HEAD
        let (_d, r) = conflict_repo();
        write_all(&r, &[("a.txt", b"1\n2\n3\n"), ("b.bin", b"\0one")]);
        commit_all(&r, "base");
        git(&r, &["checkout", "-q", "-b", "topic"]);
        write_all(&r, &[("a.txt", b"1\ntopic\n3\n"), ("b.bin", b"\0topic")]);
        commit_all(&r, "topic");
        git(&r, &["checkout", "-q", "main"]);
        write_all(&r, &[("a.txt", b"1\nmain\n3\n"), ("b.bin", b"\0main")]);
        commit_all(&r, "main");
        git(&r, &["checkout", "-q", "topic"]);
        git(&r, &["rebase", "-q", "main"]);
        assert!(r.join(".git/REBASE_HEAD").exists());
        compare_conflict_details(&r).unwrap();

        // 贮藏弹出冲突：比较 HEAD
        let (_d2, r) = conflict_repo();
        write_all(&r, &[("s.txt", b"1\n2\n3\n")]);
        commit_all(&r, "base");
        write_all(&r, &[("s.txt", b"1\nstash\n3\n")]);
        git(&r, &["stash", "-q"]);
        write_all(&r, &[("s.txt", b"1\nhead\n3\n")]);
        commit_all(&r, "head");
        git(&r, &["stash", "pop", "-q"]);
        assert_eq!(conflict_revision(&r), "HEAD");
        compare_conflict_details(&r).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn 冲突时读索引阶段与_git_show_一致() {
        let (_d, r) = merge_conflict(
            &[("c.txt", b"base\n"), ("bin", b"\0b")],
            &[("c.txt", b"ours\r\n"), ("bin", b"\0o")],
            &[("c.txt", b"theirs"), ("bin", b"\0t")],
            "c.txt text eol=crlf diff=x\n",
        );
        git(&r, &["config", "diff.x.textconv", "tr a-z A-Z <"]);
        for file in ["c.txt", "bin"] {
            for stage in [1u8, 2, 3] {
                let out = Command::new("git")
                    .arg("-C")
                    .arg(&r)
                    .args(["show", &format!(":{stage}:{file}"), "--"])
                    .output()
                    .unwrap();
                assert!(out.status.success());
                assert_eq!(crate::raw_diff::in_process::index_stage_blob(&r, stage, file).unwrap(), out.stdout);
            }
        }
        assert!(crate::raw_diff::in_process::index_stage_blob(&r, 2, "missing").is_err());
        assert!(crate::raw_diff::in_process::index_stage_blob(&r, 0, "c.txt").is_err());
    }

    /// 随机冲突：60 个文件各自随机改两边再合并，然后多轮随机改工作区（插入、删掉、改成标记样的行），
    /// 每轮与 git 对照。
    #[cfg(unix)]
    #[test]
    fn 冲突细节_随机冲突与_git_一致() {
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = |n: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % n as u64) as usize
        };
        const LINES: [&str; 10] =
            ["a", "b", "", "}", "=======", "<<<<<<< x", ">>>>>>>", "|||||||", "=======\r", "<<<<<<<"];
        let random_text = |len: usize, next: &mut dyn FnMut(usize) -> usize| -> String {
            (0..len).map(|_| format!("{}\n", if next(3) == 0 { LINES[next(LINES.len())] } else { "x" })).collect()
        };
        let mut base = Vec::new();
        let mut ours = Vec::new();
        let mut theirs = Vec::new();
        for i in 0..60 {
            let text = random_text(5 + next(20), &mut next);
            let edit = |text: &str, tag: &str, next: &mut dyn FnMut(usize) -> usize| -> String {
                let mut lines: Vec<String> = text.lines().map(|l| format!("{l}\n")).collect();
                for _ in 0..1 + next(3) {
                    let at = next(lines.len() + 1);
                    match next(3) {
                        0 if at < lines.len() => lines[at] = format!("{tag} {}\n", next(100)),
                        1 if at < lines.len() => {
                            lines.remove(at);
                        }
                        _ => lines.insert(at, format!("{tag} {}\n", next(100))),
                    }
                }
                let mut out = lines.concat();
                if next(6) == 0 {
                    out.pop();
                }
                out
            };
            let path = format!("f{i:02}.txt");
            ours.push((path.clone(), edit(&text, "ours", &mut next)));
            theirs.push((path.clone(), edit(&text, "theirs", &mut next)));
            base.push((path, text));
        }
        let view = |files: &[(String, String)]| -> Vec<(String, Vec<u8>)> {
            files.iter().map(|(p, t)| (p.clone(), t.clone().into_bytes())).collect()
        };
        let (b, o, t) = (view(&base), view(&ours), view(&theirs));
        fn slices(files: &[(String, Vec<u8>)]) -> Vec<(&str, &[u8])> {
            files.iter().map(|(p, d)| (p.as_str(), d.as_slice())).collect()
        }
        let (_d, r) = merge_conflict(&slices(&b), &slices(&o), &slices(&t), "");
        compare_conflict_details(&r).unwrap();
        let mut rounds = 1;
        for _ in 0..8 {
            for (path, _) in &base {
                let full = r.join(path);
                let Ok(text) = std::fs::read_to_string(&full) else { continue };
                if next(2) == 0 {
                    continue;
                }
                let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_string).collect();
                for _ in 0..1 + next(3) {
                    let at = next(lines.len() + 1);
                    match next(3) {
                        0 if at < lines.len() => {
                            lines.remove(at);
                        }
                        1 => lines.insert(at.min(lines.len()), format!("{}\n", LINES[next(LINES.len())])),
                        _ if at < lines.len() => lines[at] = LINES[next(LINES.len())].to_string(),
                        _ => {}
                    }
                }
                std::fs::write(&full, lines.concat()).unwrap();
            }
            compare_conflict_details(&r).unwrap();
            rounds += 1;
        }
        assert_eq!(rounds, 9);
    }

    /// gix status 自己的单线程目录遍历报出的未跟踪路径（并行遍历要逐字相同）。
    fn untracked_via_gix(root: &Path) -> Vec<String> {
        let repo = open_with_excludes(root).unwrap();
        let mut out: Vec<String> = repo
            .status(gix::progress::Discard)
            .unwrap()
            .untracked_files(gix::status::UntrackedFiles::Files)
            .into_index_worktree_iter(Vec::new())
            .unwrap()
            .map(Result::unwrap)
            .filter(|item| matches!(item, gix::status::index_worktree::Item::DirectoryContents { .. }))
            .map(|item| item.rela_path().to_string())
            .collect();
        out.sort();
        out
    }

    /// `git status --untracked-files=all` 的 `??` 条目（嵌套仓库带结尾的 `/`，去掉后比较）。
    fn untracked_via_git(root: &Path) -> Vec<String> {
        let out = git(root, &["status", "--porcelain=2", "-z", "--untracked-files=all"]);
        let mut paths: Vec<String> = out
            .split('\0')
            .filter_map(|record| record.strip_prefix("? "))
            .map(|path| path.trim_end_matches('/').to_string())
            .collect();
        paths.sort();
        paths
    }

    /// 并行遍历在每个含已跟踪文件的目录处都切分（`min_directories = 1`），1～8 个线程的结果都要与
    /// gix 的单线程遍历逐字相同，并与 git 的未跟踪集合一致；`status` 的未跟踪条目也要相同。
    fn assert_parallel_walk_matches(root: &Path) -> Vec<String> {
        let serial = untracked_via_gix(root);
        let repo = open_with_excludes(root).unwrap();
        let index = repo.index_or_empty().unwrap();
        for threads in [1, 2, 4, 8] {
            for (min_directories, partition_children) in
                [(1, 1), (1, usize::MAX), (untracked::MIN_DIRECTORIES, untracked::PARTITION_CHILDREN)]
            {
                let mut walk = untracked::Walk::new(&repo, &index).unwrap();
                walk.min_directories = min_directories;
                walk.partition_children = partition_children;
                let mut parallel = walk.run(threads).unwrap();
                parallel.sort();
                assert_eq!(
                    parallel, serial,
                    "threads={threads} min_directories={min_directories} partition_children={partition_children}"
                );
            }
        }
        let trimmed: Vec<String> = serial.iter().map(|path| path.trim_end_matches('/').to_string()).collect();
        assert_eq!(trimmed, untracked_via_git(root), "与 git 的未跟踪集合不同");
        let mut listed: Vec<String> = status(root)
            .unwrap()
            .changes
            .into_iter()
            .filter(|change| change.kind == ChangeKind::Untracked)
            .map(|change| change.path)
            .collect();
        listed.sort();
        assert_eq!(listed, serial, "status 的未跟踪条目");
        serial
    }

    fn write(root: &Path, path: &str, content: &str) {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    /// 切分处的边界情形：上层与嵌套的 `.gitignore`（否定、只匹配目录、`**`、锚定）、info/exclude、
    /// 被忽略目录里强制加入的已跟踪文件、已跟踪目录里的未跟踪目录 / 嵌套仓库 / 空目录 / 符号链接 / FIFO、
    /// 只含被忽略文件的未跟踪目录、中文与空格文件名。
    #[cfg(unix)]
    #[test]
    fn 并行遍历未跟踪文件与_gix_和_git_一致() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().join("repo");
        std::fs::create_dir_all(&r).unwrap();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        write(&r, ".gitignore", "*.log\n!keep.log\nbuild/\n/rootonly.txt\ndeep/**/gen/\ndocs/*.tmp\na/b/\n");
        write(&r, ".git/info/exclude", "*.secret\n");
        for dir in ["a", "a/b", "a/b/c", "a/b/c/d", "a/x", "deep/one/two", "docs", "src/中文 目录", "Upper/Case"] {
            write(&r, &format!("{dir}/tracked.txt"), "t\n");
            write(&r, &format!("{dir}/more.rs"), "t\n");
        }
        write(&r, "a/.gitignore", "!important.log\n*.txt\n");
        write(&r, "a/b/c/.gitignore", "!*.txt\n");
        write(&r, "build/forced.o", "o\n");
        git(&r, &["add", "-A"]);
        git(&r, &["add", "-f", "build/forced.o", "a/tracked.txt", "a/x/tracked.txt", "a/b/tracked.txt"]);
        git(&r, &["add", "-f", "a/b/c/tracked.txt", "a/b/c/d/tracked.txt", "a/b/more.rs", "a/b/c/more.rs"]);
        git(&r, &["add", "-f", "a/b/c/d/more.rs", "a/b/c/.gitignore"]);
        git(&r, &["commit", "-qm", "base"]);

        for dir in ["", "a", "a/b", "a/b/c", "a/b/c/d", "a/x", "deep/one/two", "docs", "src/中文 目录", "Upper/Case"]
        {
            let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
            for name in ["new.txt", "new file.md", "x.log", "keep.log", "important.log", "s.secret", "n.tmp"] {
                write(&r, &format!("{prefix}{name}"), "u\n");
            }
            write(&r, &format!("{prefix}untracked-dir/inner/f.rs"), "u\n");
            write(&r, &format!("{prefix}only-ignored/z.log"), "u\n");
            write(&r, &format!("{prefix}gen/g.rs"), "u\n");
            std::fs::create_dir_all(r.join(format!("{prefix}empty-dir/nested"))).unwrap();
        }
        write(&r, "rootonly.txt", "u\n");
        write(&r, "a/rootonly.txt", "u\n");
        write(&r, "build/new.o", "u\n");
        write(&r, "deep/one/two/gen/deeper/x.rs", "u\n");
        let nested = r.join("a/x/nested-repo");
        std::fs::create_dir_all(&nested).unwrap();
        git(&nested, &["init", "-q", "."]);
        write(&nested, "inside.txt", "u\n");
        std::os::unix::fs::symlink("tracked.txt", r.join("a/x/link")).unwrap();
        std::os::unix::fs::symlink("../a", r.join("docs/dir-link")).unwrap();
        let fifo = Command::new("mkfifo").arg(r.join("a/x/fifo")).status().unwrap();
        assert!(fifo.success());

        let found = assert_parallel_walk_matches(&r);
        // 夹具确实覆盖到了：切分处上层的否定规则、被忽略目录里的已跟踪子目录、深层未跟踪目录、嵌套仓库、符号链接
        for path in [
            "a/x/important.log",
            "a/x/untracked-dir/inner/f.rs",
            "a/x/nested-repo",
            "a/x/link",
            "docs/dir-link",
            "src/中文 目录/new file.md",
        ] {
            assert!(found.iter().any(|f| f == path), "{path}: {found:?}");
        }
        for path in [
            "a/x/new.txt",
            "a/b/c/new.txt",
            "build/new.o",
            "deep/one/two/gen/deeper/x.rs",
            "a/x/fifo",
            "s.secret",
            "docs/n.tmp",
        ] {
            assert!(!found.iter().any(|f| f == path), "{path} 不该列出");
        }
    }

    /// 随机目录树与随机忽略规则，多轮随机增删文件后逐轮对照 gix 的单线程遍历与 git。
    #[cfg(unix)]
    #[test]
    fn 并行遍历未跟踪文件_随机目录树与_git_一致() {
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let mut next = |n: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % n as u64) as usize
        };
        const NAMES: [&str; 8] = ["a", "b", "gen", "out", "Lib", "x y", "中", "node"];
        const FILES: [&str; 8] = ["f.rs", "g.txt", "h.log", "keep.log", "i.tmp", "j.o", "README", ".hidden"];
        const RULES: [&str; 12] = [
            "*.log",
            "!keep.log",
            "gen/",
            "/out",
            "*.tmp",
            "node/",
            "**/b/*.o",
            "!a/",
            "x y/",
            "*.txt",
            "!g.txt",
            "Lib/**",
        ];
        let d = tempfile::tempdir().unwrap();
        let r = d.path().join("repo");
        std::fs::create_dir_all(&r).unwrap();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        let random_dir = |next: &mut dyn FnMut(usize) -> usize| -> String {
            (0..1 + next(4)).map(|_| NAMES[next(NAMES.len())]).collect::<Vec<_>>().join("/")
        };
        for _ in 0..120 {
            let path = format!("{}/{}", random_dir(&mut next), FILES[next(FILES.len())]);
            write(&r, &path, "t\n");
        }
        git(&r, &["add", "-A", "-f"]);
        git(&r, &["commit", "-qm", "base"]);
        for round in 0..6 {
            for _ in 0..4 {
                let dir = random_dir(&mut next);
                let rules: String = (0..1 + next(3)).map(|_| format!("{}\n", RULES[next(RULES.len())])).collect();
                let at = if next(3) == 0 { String::from(".gitignore") } else { format!("{dir}/.gitignore") };
                write(&r, &at, &rules);
            }
            for _ in 0..40 {
                let path = format!("{}/{}", random_dir(&mut next), FILES[next(FILES.len())]);
                if next(4) == 0 {
                    let _ = std::fs::remove_file(r.join(&path));
                } else {
                    write(&r, &path, "u\n");
                }
            }
            if round % 2 == 1 {
                git(&r, &["add", "-A"]);
            }
            assert_parallel_walk_matches(&r);
        }
    }
}
