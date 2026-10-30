//! 文件历史 —— History 标签页「查看文件历史」的数据来源。
//!
//! Git 行为照 GitLens `getLogForPath` → `getLogCore`（Vendor/vscode-gitlens c1f6e5f3c，
//! packages/git-cli/src/providers/commits.ts，MIT）：文件历史默认跟重命名（`--follow`，
//! `advanced.fileHistoryFollowsRenames` 默认 true）、不列合并提交（`--no-merges`，
//! `advanced.fileHistoryShowMergeCommits` 默认 false）、只走当前分支（`fileHistoryShowAllBranches`
//! 默认 false）、重命名不设上限（`gitConfigsLogWithFiles` 的 `-c diff.renameLimit=0`）、
//! 多取一条判断还有没有（`-n<limit+1>`），工作区里找不到历史时改用暂存重命名前的路径。
//! 提交格式沿用 Desktop `getCommits`（app/src/lib/git/log.ts），和 History 列表同一份。
//!
//! 翻页与 GitLens 不同：GitLens `getLogCoreMoreFn` 从上一页最后一个提交的第一父提交（`<sha>^`）
//! 重新 `--follow`，合并进来的侧枝上、比它旧的提交会漏掉；这里按「前 skip+limit+1 条」重走，
//! 结果恰好是同一条 `git log --follow` 的前缀（`--max-count` 数的是显示出来的提交，
//! builtin/log.c `cmd_log_walk_no_free` 会把没显示的补回去；`--skip` 不是，所以不用它）。
//!
//! 常见仓库在进程内完成，与 `git log --follow` 逐字节一致：遍历顺序复用 History 列表的
//! [`DateWalk`]，每个非合并提交只比较这一个路径（log-tree.c `log_tree_diff`：没有 `-m`/`--cc`
//! 时合并提交不做 diff，`--follow` 下也就不显示、不改名）；路径在某个提交里新出现时按
//! tree-diff.c `try_to_follow_renames` 找来源（全树做源的 `--find-copies-harder`，只看这一个目标，
//! diffcore-rename.c 的精确匹配、相似度估计与候选排序），找到就从此跟旧路径。其余情况
//! （路径是目录或子模块、通配符、CRLF 内容且可能受 gitattributes 影响、对象缺失等）交给 git。

use crate::history::{CommitDetails, DateWalk, FastLog};
use std::collections::{HashMap, VecDeque};
use std::path::Path;

type ObjectId = gix::ObjectId;

/// 一页文件历史。`has_more` 来自多取的那一条。
pub struct Page {
    pub commits: Vec<CommitDetails>,
    pub has_more: bool,
    /// 下一页从这里接着走（见 [`cursors`]）。没有下一页、这一页交给了 git、或者遍历结果依赖
    /// 工作区里会变的东西（gitattributes）时为 `None`，下一页照旧从头走。
    pub cursor: Option<String>,
    /// 这一页是接着游标走出来的（基准与测试核对用）。
    pub resumed: bool,
}

/// 从 HEAD 起改过 `path` 的第 `skip` 条起的 `limit` 条提交，最新的在前。
///
/// `cursor` 是上一页返回的游标：仓库、文件、页码、HEAD 都对得上时接着上一页停下的地方走，
/// 不再重走前面的提交；对不上、过期或接着走出错就从头走，结果相同。
pub fn file_history(root: &Path, path: &str, skip: usize, limit: usize, cursor: Option<&str>) -> Result<Page, String> {
    if let Some(saved) = cursor.and_then(cursors::take) {
        match resume(root, path, skip, limit, saved) {
            Ok(page) => return Ok(page),
            Err(reason) => log::debug!("file history cursor dropped for {}: {reason}", root.display()),
        }
    }
    let wanted = skip.saturating_add(limit).saturating_add(1);
    match page_in_process(root, path, skip, limit) {
        Ok(Some(page)) => return Ok(page),
        Ok(None) => {}
        Err(reason) => {
            log::debug!("file history fast path unavailable for {}: {reason}", root.display());
            let commits = follow_via_git(root, path, wanted)?;
            if !commits.is_empty() {
                return Ok(slice(commits, skip, limit));
            }
        }
    }
    // getLogCore：「If we didn't find any history from the working tree, check to see if the file was
    // renamed」——暂存的重命名在 HEAD 里还没有新路径，改用状态里的原路径。这条路不留游标：
    // 结果还取决于暂存区。
    let commits = match staged_original_path(root, path) {
        Some(original) => follow(root, &original, wanted)?,
        None => Vec::new(),
    };
    Ok(slice(commits, skip, limit))
}

/// 前 `skip+limit+1` 条里切出这一页。
fn slice(mut commits: Vec<CommitDetails>, skip: usize, limit: usize) -> Page {
    let end = skip.saturating_add(limit);
    let has_more = commits.len() > end;
    commits.truncate(end);
    let commits = commits.split_off(skip.min(commits.len()));
    Page { commits, has_more, cursor: None, resumed: false }
}

/// 状态里 `path` 这一项的重命名原路径（GitLens `getStatusForFile(...).originalPath`）。
fn staged_original_path(root: &Path, path: &str) -> Option<String> {
    let status = crate::status::status(root).ok()?;
    status.changes.into_iter().find(|change| change.path == path).and_then(|change| change.old_path)
}

/// 前 `max` 条：能在进程内答就在进程内答，否则走 git。
pub fn follow(root: &Path, path: &str, max: usize) -> Result<Vec<CommitDetails>, String> {
    match follow_in_process(root, path, max) {
        Ok(commits) => Ok(commits),
        Err(reason) => {
            log::debug!("file history fast path unavailable for {}: {reason}", root.display());
            follow_via_git(root, path, max)
        }
    }
}

/// GitLens 文件历史的 git 命令换上 Desktop 的提交格式：`-M` 与 `--use-mailmap` 不影响这个格式
/// 的输出（`%an`/`%ae` 不按 mailmap 改写，`-M` 不带数值时阈值与 `--follow` 默认相同），没有带上。
pub fn follow_via_git(root: &Path, path: &str, max: usize) -> Result<Vec<CommitDetails>, String> {
    let output = crate::git::Git::new(Some(root))
        .args(["-c", "diff.renameLimit=0", "log", "--date=raw"])
        .arg(format!("--max-count={max}"))
        .args(["-z", crate::history::DETAILS_FORMAT, "--no-show-signature", "--no-color", "--no-merges", "--follow"])
        .args(["--", path])
        .output()?;
    if output.status.code() == Some(128) {
        return Ok(Vec::new());
    }
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    crate::history::parse_details(&output.stdout)
}

/// diffcore.h `MAX_SCORE` 与 `DEFAULT_RENAME_SCORE`（50%）。
const MAX_SCORE: u64 = 60000;
const MINIMUM_SCORE: i64 = 30000;
/// diffcore-rename.c `NUM_CANDIDATE_PER_DST`。
const CANDIDATES: usize = 4;

/// 打开仓库并确定起点：`Ok(None)` 是没有提交（未出生的 HEAD，git 以 128 退出）。
fn open(root: &Path, path: &str) -> Result<Option<(FastLog, ObjectId, bool)>, String> {
    literal_path(path)?;
    let log = FastLog::open(root)?;
    // builtin/log.c：`log.showRoot` 关掉时根提交不做 diff，也就不显示。
    let show_root = log.repo.config_snapshot().boolean("log.showRoot").unwrap_or(true);
    let Some(head) = log.head() else { return Ok(None) };
    let head = log.peel_commit(head)?;
    Ok(Some((log, head, show_root)))
}

/// `git -c diff.renameLimit=0 log --follow --no-merges … -- <path>` 的进程内实现。
/// `Err` 只表示「这次交给 git」，不是失败。
pub(crate) fn follow_in_process(root: &Path, path: &str, max: usize) -> Result<Vec<CommitDetails>, String> {
    let Some((log, head, show_root)) = open(root, path)? else { return Ok(Vec::new()) };
    if max == 0 {
        return Ok(Vec::new());
    }
    let mut walker = Walker::start(&log, path, head, show_root)?;
    let mut out = Vec::new();
    while out.len() < max
        && let Some((id, data)) = walker.next_shown()?
    {
        out.push(log.render(id, &data)?);
    }
    Ok(out)
}

/// 从头走的一页：`Ok(None)` 是这个路径一条历史也没有（调用方再看暂存的重命名）。
fn page_in_process(root: &Path, path: &str, skip: usize, limit: usize) -> Result<Option<Page>, String> {
    let Some((log, head, show_root)) = open(root, path)? else { return Ok(None) };
    let mut walker = Walker::start(&log, path, head, show_root)?;
    let Some(first) = walker.next_shown()? else { return Ok(None) };
    // 跳过的提交只数不渲染。
    let end = skip.saturating_add(limit);
    let (commits, pending) = fill_page(&log, &mut walker, 0, Some(first), skip, end)?;
    let key = cursors::Key { root: root.to_path_buf(), path: path.to_string(), head, show_root };
    Ok(Some(finish(walker, key, end, commits, pending, false)))
}

/// 接着游标走一页。任何不一致都是 `Err`，调用方从头走。
fn resume(root: &Path, path: &str, skip: usize, limit: usize, saved: cursors::Saved) -> Result<Page, String> {
    if saved.key.root.as_path() != root || saved.key.path != path {
        return Err("the cursor belongs to another file".into());
    }
    if saved.shown != skip {
        return Err(format!("the cursor stopped at {} rather than {skip}", saved.shown));
    }
    let Some((log, head, show_root)) = open(root, path)? else { return Err("HEAD is unborn now".into()) };
    if head != saved.key.head {
        return Err("HEAD moved".into());
    }
    if show_root != saved.key.show_root {
        return Err("log.showRoot changed".into());
    }
    let (key, pending, mut walker) = Walker::resume(&log, saved)?;
    let end = skip.saturating_add(limit);
    let (commits, pending) = fill_page(&log, &mut walker, skip, Some(pending), skip, end)?;
    Ok(finish(walker, key, end, commits, pending, true))
}

/// 一个要显示的提交：对象号与提交数据（渲染放到真正输出它的那一页，装饰总是最新的）。
type Shown = (ObjectId, Vec<u8>);

/// 第 `shown` 条是 `next`，往后取到第 `end` 条为止：`[skip, end)` 渲染出来，第 `end` 条留作下一页的开头。
fn fill_page(
    log: &FastLog, walker: &mut Walker<'_>, mut shown: usize, mut next: Option<Shown>, skip: usize, end: usize,
) -> Result<(Vec<CommitDetails>, Option<Shown>), String> {
    let mut commits = Vec::new();
    while let Some((id, data)) = next {
        if shown == end {
            return Ok((commits, Some((id, data))));
        }
        if shown >= skip {
            commits.push(log.render(id, &data)?);
        }
        shown += 1;
        next = walker.next_shown()?;
    }
    Ok((commits, None))
}

fn finish(
    walker: Walker<'_>, key: cursors::Key, end: usize, commits: Vec<CommitDetails>, pending: Option<Shown>,
    resumed: bool,
) -> Page {
    let has_more = pending.is_some();
    let cursor = pending.and_then(|pending| walker.save(key, end, pending)).map(cursors::put);
    Page { commits, has_more, cursor, resumed }
}

/// 按遍历顺序逐个判断「这个提交显不显示」。
///
/// 耗时几乎全在读路径沿途的树。每个提交「这个路径变了没有」只取决于它和父提交的树，
/// 所以按遍历顺序分批，同一批分给几个线程各查一段（各自的仓库句柄与缓存）；
/// 之后在本线程按顺序消费：遇到新建就找来源，改了路径就把这一批剩下的用新路径重查。
/// 输出与逐个提交顺序处理完全相同；停下时整个状态（队列、已见集合、跟着的路径、这一批
/// 还没消费的提交与查好的结果）可以存成游标，下一页接着消费。
struct Walker<'a> {
    log: &'a FastLog,
    show_root: bool,
    follow: Follow<'a>,
    walk: DateWalk<'a>,
    probes: Vec<Probe>,
    items: VecDeque<Item>,
    changes: VecDeque<Result<Change, String>>,
    batch_size: usize,
    exhausted: bool,
}

impl<'a> Walker<'a> {
    fn start(log: &'a FastLog, path: &str, head: ObjectId, show_root: bool) -> Result<Self, String> {
        let walk = DateWalk::new(log, [head])?;
        // 第一批小一些：常改的文件第一页往往只要走几百个提交。
        Ok(Self::assemble(log, show_root, path.as_bytes().to_vec(), walk, VecDeque::new(), VecDeque::new(), 256, false))
    }

    #[allow(clippy::too_many_arguments)]
    fn assemble(
        log: &'a FastLog, show_root: bool, path: Vec<u8>, walk: DateWalk<'a>, items: VecDeque<Item>,
        changes: VecDeque<Result<Change, String>>, batch_size: usize, exhausted: bool,
    ) -> Self {
        let threads = std::thread::available_parallelism().map_or(1, usize::from).clamp(1, 8);
        let probes = (0..threads).map(|_| Probe::new(log.repo.clone())).collect();
        Walker { log, show_root, follow: Follow::new(log, path), walk, probes, items, changes, batch_size, exhausted }
    }

    fn resume(log: &'a FastLog, saved: cursors::Saved) -> Result<(cursors::Key, Shown, Self), String> {
        let walk = DateWalk::resume(log, saved.walk)?;
        let walker = Self::assemble(
            log,
            saved.key.show_root,
            saved.path,
            walk,
            saved.items,
            saved.changes,
            saved.batch_size,
            saved.exhausted,
        );
        Ok((saved.key, saved.pending, walker))
    }

    /// 存成游标。改名检测读过 gitattributes 时不存：属性来自工作区和索引，下一页时可能已经变了。
    fn save(self, key: cursors::Key, shown: usize, pending: Shown) -> Option<cursors::Saved> {
        if self.follow.attributes.is_some() {
            return None;
        }
        Some(cursors::Saved {
            key,
            shown,
            pending,
            walk: self.walk.into_state(),
            path: self.follow.path,
            items: self.items,
            changes: self.changes,
            batch_size: self.batch_size,
            exhausted: self.exhausted,
        })
    }

    /// 取一批提交并行查好路径变化，排在队尾。
    fn fill(&mut self) -> Result<(), String> {
        let mut batch = Vec::with_capacity(self.batch_size);
        while batch.len() < self.batch_size {
            let Some(step) = self.walk.next_step()? else { break };
            // log-tree.c `log_tree_diff`：合并提交不做 diff；根提交只在 show_root 时和空树比。
            let old = match step.parents.as_slice() {
                [] if self.show_root => Some(None),
                [parent] => Some(Some(self.log.root_tree(*parent)?)),
                _ => None,
            };
            batch.push(Item { step, old });
        }
        self.exhausted = batch.len() < self.batch_size;
        let changes = probe_all(&mut self.probes, &self.follow.components, &batch);
        self.items.extend(batch);
        self.changes.extend(changes);
        self.batch_size = (self.batch_size * 2).min(8192);
        Ok(())
    }

    /// 下一个要显示的提交；走完是 `None`。
    fn next_shown(&mut self) -> Result<Option<Shown>, String> {
        loop {
            let Some(mut item) = self.items.pop_front() else {
                if self.exhausted {
                    return Ok(None);
                }
                self.fill()?;
                continue;
            };
            let change = self.changes.pop_front().expect("one change per queued commit");
            let Some(old) = item.old else { continue };
            let shown = match change? {
                None => false,
                Some((None, Some(created))) => {
                    // diff_might_be_rename：这一个路径是新建的，按全树找来源，找到就从此跟旧路径。
                    if let Some(old) = old
                        && let Some(source) = self.follow.find_source(old, item.step.tree, created)?
                    {
                        self.follow.set_path(source);
                        for probe in &mut self.probes {
                            probe.lookups.clear();
                        }
                        let rest = probe_all(&mut self.probes, &self.follow.components, self.items.make_contiguous());
                        self.changes = rest.into();
                    }
                    true
                }
                Some(_) => true,
            };
            if shown {
                let id = item.step.id;
                return Ok(Some((id, item.step.take_data(&self.log.repo)?)));
            }
        }
    }
}

/// 文件历史的续走游标。
///
/// 游标只在本进程内存里，前端拿到的是一个不透明的编号。一个游标只能用一次（取出即删除），
/// 最多同时留 [`MAX`] 个、每个最多 [`TTL`]；同一仓库同一文件只留最新的那个，换文件、刷新后
/// 旧编号自然失效。取回后还要核对仓库、文件、页码、HEAD 与 `log.showRoot`，队列里的提交按
/// 现在的仓库重新定位并核对排序日期（[`DateWalk::resume`]），任何一项对不上都从头走。
///
/// 游标之外的东西都按这次调用重新读：装饰（引用可能变了）、缩写长度、配置里让位给 git 的项。
/// 遍历本身只取决于 HEAD、提交与树（对象不可变）和改名检测；改名检测用到 gitattributes 的
/// 不留游标。
mod cursors {
    use super::{Change, Item, ObjectId, Shown};
    use std::collections::VecDeque;
    use std::path::PathBuf;
    #[cfg(not(test))]
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    /// 同时保留的游标数：每个游标的已见集合与 Homebrew 这样的仓库全量相当（几 MB）。
    pub(super) const MAX: usize = 4;
    pub(super) const TTL: Duration = Duration::from_secs(10 * 60);

    /// 游标属于哪次遍历。
    pub(super) struct Key {
        pub(super) root: PathBuf,
        pub(super) path: String,
        pub(super) head: ObjectId,
        pub(super) show_root: bool,
    }

    pub(super) struct Saved {
        pub(super) key: Key,
        /// 已经输出的条数；`pending` 是第 `shown` 条（从 0 数），下一页的第一条。
        pub(super) shown: usize,
        pub(super) pending: Shown,
        pub(super) walk: crate::history::WalkState,
        /// 现在跟着的路径（可能已经改过名）。
        pub(super) path: Vec<u8>,
        pub(super) items: VecDeque<Item>,
        pub(super) changes: VecDeque<Result<Change, String>>,
        pub(super) batch_size: usize,
        pub(super) exhausted: bool,
    }

    struct Entry {
        token: String,
        at: Instant,
        saved: Saved,
    }

    static NEXT: AtomicU64 = AtomicU64::new(1);

    #[cfg(not(test))]
    static STORE: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

    #[cfg(not(test))]
    fn with_store<T>(f: impl FnOnce(&mut Vec<Entry>) -> T) -> T {
        f(&mut STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    // 测试并行跑，各线程各用一份，互不挤掉对方的游标。
    #[cfg(test)]
    thread_local! {
        static STORE: std::cell::RefCell<Vec<Entry>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    #[cfg(test)]
    fn with_store<T>(f: impl FnOnce(&mut Vec<Entry>) -> T) -> T {
        STORE.with_borrow_mut(f)
    }

    pub(super) fn put(saved: Saved) -> String {
        let token = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
        with_store(|store| insert(store, token.clone(), saved));
        token
    }

    fn insert(store: &mut Vec<Entry>, token: String, saved: Saved) {
        let now = Instant::now();
        store.retain(|entry| {
            now.duration_since(entry.at) < TTL
                && !(entry.saved.key.root == saved.key.root && entry.saved.key.path == saved.key.path)
        });
        if store.len() >= MAX {
            store.remove(0);
        }
        store.push(Entry { token, at: now, saved });
    }

    /// 取出并删除；过期的当作没有。
    pub(super) fn take(token: &str) -> Option<Saved> {
        with_store(|store| {
            let index = store.iter().position(|entry| entry.token == token)?;
            let entry = store.remove(index);
            (entry.at.elapsed() < TTL).then_some(entry.saved)
        })
    }

    #[cfg(test)]
    pub(super) fn len() -> usize {
        with_store(|store| store.len())
    }

    /// 让一个游标看起来已经过期。
    #[cfg(test)]
    pub(super) fn age(token: &str) {
        with_store(|store| {
            for entry in store.iter_mut().filter(|entry| entry.token == token) {
                entry.at = Instant::now().checked_sub(TTL).expect("monotonic clock far enough from zero");
            }
        });
    }
}

/// 一批里的一个提交：`old` 是要比的父提交根树，`Some(None)` 是和空树比的根提交，`None` 不比（合并提交）。
struct Item {
    step: crate::history::Step,
    old: Option<Option<ObjectId>>,
}

/// 路径在两棵树之间的变化：(旧, 新)，没变是 `None`。
type Change = Option<(Option<Leaf>, Option<Leaf>)>;

/// 每个提交单独出错（例如某个提交里这个路径是目录），只有顺序消费到它时才让位给 git。
fn probe_all(probes: &mut [Probe], components: &[Vec<u8>], items: &[Item]) -> Vec<Result<Change, String>> {
    let probe = |probe: &mut Probe, items: &[Item]| -> Vec<Result<Change, String>> {
        items
            .iter()
            .map(|item| match item.old {
                None => Ok(None),
                Some(old) => probe.changed(components, old, item.step.tree),
            })
            .collect()
    };
    // 线程启动比查几十个提交还贵，小批直接在本线程查。
    if items.len() < 64 || probes.len() == 1 {
        return probe(&mut probes[0], items);
    }
    let chunk = items.len().div_ceil(probes.len());
    std::thread::scope(|scope| {
        let handles: Vec<_> = probes
            .iter_mut()
            .zip(items.chunks(chunk))
            .map(|(worker, items)| scope.spawn(move || probe(worker, items)))
            .collect();
        handles.into_iter().flat_map(|handle| handle.join().expect("file history probe panicked")).collect()
    })
}

/// 一个线程查路径用的仓库句柄与缓存。
struct Probe {
    repo: gix::Repository,
    /// (树, 第几层) → 这一层要找的那个名字对应的条目。路径改了就清空。
    lookups: HashMap<(ObjectId, usize), Option<(gix::object::tree::EntryKind, ObjectId)>>,
    buffer: Vec<u8>,
}

impl Probe {
    fn new(mut repo: gix::Repository) -> Self {
        // 每棵树只读一次，对象缓存只会白白复制；增量基缓存保留 gix 的默认（每个句柄 64 个）。
        repo.objects.unset_object_cache();
        Probe { repo, lookups: HashMap::new(), buffer: Vec::new() }
    }

    fn entry(
        &mut self, components: &[Vec<u8>], tree: ObjectId, depth: usize,
    ) -> Result<Option<(gix::object::tree::EntryKind, ObjectId)>, String> {
        use gix::objs::FindExt;
        if let Some(found) = self.lookups.get(&(tree, depth)) {
            return Ok(*found);
        }
        let name = components[depth].as_slice();
        let mut found = None;
        for entry in self.repo.objects.find_tree_iter(&tree, &mut self.buffer).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.filename.as_ref() as &[u8] == name {
                found = Some((entry.mode.kind(), entry.oid.to_owned()));
                break;
            }
        }
        self.lookups.insert((tree, depth), found);
        Ok(found)
    }

    /// 这个路径在两棵树之间变了没有（tree-diff.c 只比 pathspec 下的条目，相同的子树直接跳过）。
    /// 路径在任何一侧是目录或子模块时 pathspec 的含义不同，交给 git。
    fn changed(&mut self, components: &[Vec<u8>], old: Option<ObjectId>, new: ObjectId) -> Result<Change, String> {
        use gix::object::tree::EntryKind;
        let last = components.len() - 1;
        let (mut old, mut new) = (old, Some(new));
        for depth in 0..=last {
            if old == new {
                return Ok(None);
            }
            let old_entry = match old {
                Some(tree) => self.entry(components, tree, depth)?,
                None => None,
            };
            let new_entry = match new {
                Some(tree) => self.entry(components, tree, depth)?,
                None => None,
            };
            if depth == last {
                let leaf = |entry: Option<(EntryKind, ObjectId)>| match entry {
                    None => Ok(None),
                    Some((EntryKind::Tree, _)) => Err("the path is a directory in some revision".to_string()),
                    Some((EntryKind::Commit, _)) => Err("the path is a submodule in some revision".to_string()),
                    Some((kind, id)) => Ok(Some(Leaf { kind, id })),
                };
                let (old_leaf, new_leaf) = (leaf(old_entry)?, leaf(new_entry)?);
                return Ok((old_leaf != new_leaf).then_some((old_leaf, new_leaf)));
            }
            let subtree = |entry: Option<(EntryKind, ObjectId)>| {
                entry.filter(|(kind, _)| *kind == EntryKind::Tree).map(|(_, id)| id)
            };
            old = subtree(old_entry);
            new = subtree(new_entry);
        }
        unreachable!("the loop returns at the last component")
    }
}

/// 只接受规范的相对路径：没有 pathspec 魔法和通配符，git 才会把它当成一个字面路径来比。
fn literal_path(path: &str) -> Result<(), String> {
    let bad = path.is_empty()
        || path.starts_with(':')
        || path.contains(['*', '?', '[', '\\'])
        || path.split('/').any(|component| component.is_empty() || component == "." || component == "..");
    if bad { Err(format!("pathspec {path:?} is not a plain path")) } else { Ok(()) }
}

/// 树里一个非目录条目。比较用种类（canon_mode 之后的模式）和对象。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Leaf {
    kind: gix::object::tree::EntryKind,
    id: ObjectId,
}

impl Leaf {
    fn is_regular(&self) -> bool {
        matches!(self.kind, gix::object::tree::EntryKind::Blob | gix::object::tree::EntryKind::BlobExecutable)
    }
}

/// 改名检测的一个来源：旧树里的一个非目录条目，以及它在新树里是否已经不在（删除的来源优先当作改名）。
struct Source {
    path: Vec<u8>,
    leaf: Leaf,
    deleted: bool,
}

/// diffcore-delta.c `hash_chars` 的结果：按哈希值升序、合并过的 (哈希, 字节数)。
type Spans = Vec<(u32, u32)>;

/// 当前跟着的路径，以及在本线程做的改名检测。
struct Follow<'a> {
    log: &'a FastLog,
    path: Vec<u8>,
    components: Vec<Vec<u8>>,
    sizes: HashMap<ObjectId, u64>,
    spans: HashMap<ObjectId, std::rc::Rc<Hashed>>,
    attributes: Option<gix::AttributeStack<'a>>,
}

impl<'a> Follow<'a> {
    fn new(log: &'a FastLog, path: Vec<u8>) -> Self {
        let mut follow = Follow {
            log,
            path: Vec::new(),
            components: Vec::new(),
            sizes: HashMap::new(),
            spans: HashMap::new(),
            attributes: None,
        };
        follow.set_path(path);
        follow
    }

    fn set_path(&mut self, path: Vec<u8>) {
        self.components = path.split(|b| *b == b'/').map(<[u8]>::to_vec).collect();
        self.path = path;
    }

    /// tree-diff.c `try_to_follow_renames`：旧树的全部非目录条目做来源（`find_copies_harder`），
    /// 目标只有新建的这一个路径（`single_follow`），走 diffcore-rename.c 的
    /// `find_exact_renames` → `estimate_similarity` → `find_renames`（先改名、再复制）。
    fn find_source(&mut self, old: ObjectId, new: ObjectId, target: Leaf) -> Result<Option<Vec<u8>>, String> {
        let mut sources = Vec::new();
        self.collect(old, Some(new), &mut Vec::new(), &mut sources)?;
        if sources.is_empty() {
            return Ok(None);
        }

        // find_identical_files：同一个对象的来源按路径顺序逐个看，没用过的（删除的）加一分、
        // 基名相同再加一分，严格更高才换，满分即停，最多看 100 个。
        let mut best: Option<usize> = None;
        let mut best_score = -1;
        let mut budget = 100;
        for (index, source) in sources.iter().enumerate() {
            if source.leaf.id != target.id {
                continue;
            }
            if (!source.leaf.is_regular() || !target.is_regular()) && source.leaf.kind != target.kind {
                continue;
            }
            let score = i32::from(source.deleted) + i32::from(basename_same(&source.path, &self.path));
            if score > best_score {
                best = Some(index);
                best_score = score;
                if score == 2 {
                    break;
                }
            }
            budget -= 1;
            if budget == 0 {
                break;
            }
        }
        if let Some(index) = best {
            return Ok(Some(std::mem::take(&mut sources[index].path)));
        }

        // 不精确匹配：每个来源估一次相似度，`record_if_better` 只留四个候选，稳定排序后
        // 第一轮只接受删除的来源（改名），第二轮接受任何来源（复制）。
        let mut slots: [Option<Candidate>; CANDIDATES] = [None; CANDIDATES];
        for (index, source) in sources.iter().enumerate() {
            let score = self.estimate_similarity(source, target)?;
            let candidate =
                Candidate { score, name_score: i32::from(basename_same(&source.path, &self.path)), src: index };
            record_if_better(&mut slots, candidate);
        }
        // STABLE_QSORT(mx, …, score_compare)
        let mut sorted: Vec<Option<Candidate>> = slots.to_vec();
        sorted.sort_by(|a, b| score_compare(a, b).cmp(&0));
        for copies in [false, true] {
            for candidate in &sorted {
                let Some(candidate) = candidate else { break };
                if candidate.score < MINIMUM_SCORE {
                    break;
                }
                if !copies && !sources[candidate.src].deleted {
                    continue;
                }
                return Ok(Some(std::mem::take(&mut sources[candidate.src].path)));
            }
        }
        Ok(None)
    }

    /// 旧树按 git 的树序展开成来源；新树里同名的非目录条目还在就不算删除。
    fn collect(
        &self, old: ObjectId, new: Option<ObjectId>, prefix: &mut Vec<u8>, out: &mut Vec<Source>,
    ) -> Result<(), String> {
        use gix::object::tree::EntryKind;
        let entries = |id: ObjectId| -> Result<Vec<(Vec<u8>, EntryKind, ObjectId)>, String> {
            let tree = self.log.repo.find_tree(id).map_err(|e| e.to_string())?;
            let decoded = tree.decode().map_err(|e| e.to_string())?;
            Ok(decoded.entries.iter().map(|e| (e.filename.to_vec(), e.mode.kind(), e.oid.to_owned())).collect())
        };
        let old_entries = entries(old)?;
        let new_entries: HashMap<Vec<u8>, (EntryKind, ObjectId)> = match new {
            Some(id) if id == old => old_entries.iter().map(|(name, kind, id)| (name.clone(), (*kind, *id))).collect(),
            Some(id) => entries(id)?.into_iter().map(|(name, kind, id)| (name, (kind, id))).collect(),
            None => HashMap::new(),
        };
        for (name, kind, id) in old_entries {
            let length = prefix.len();
            prefix.extend_from_slice(&name);
            let counterpart = new_entries.get(&name).copied();
            if kind == EntryKind::Tree {
                let subtree = counterpart.filter(|(kind, _)| *kind == EntryKind::Tree).map(|(_, id)| id);
                prefix.push(b'/');
                self.collect(id, subtree, prefix, out)?;
            } else {
                let deleted = counterpart.is_none_or(|(kind, _)| kind == EntryKind::Tree);
                out.push(Source { path: prefix.clone(), leaf: Leaf { kind, id }, deleted });
            }
            prefix.truncate(length);
        }
        Ok(())
    }

    fn size(&mut self, id: ObjectId) -> Result<u64, String> {
        if let Some(size) = self.sizes.get(&id) {
            return Ok(*size);
        }
        let size = self.log.repo.find_header(id).map_err(|e| e.to_string())?.size();
        self.sizes.insert(id, size);
        Ok(size)
    }

    /// diffcore-rename.c `estimate_similarity`：只比普通文件；大小相差太多的不读内容。
    fn estimate_similarity(&mut self, source: &Source, target: Leaf) -> Result<i64, String> {
        if !source.leaf.is_regular() || !target.is_regular() {
            return Ok(0);
        }
        let src_size = self.size(source.leaf.id)?;
        let dst_size = self.size(target.id)?;
        let max_size = src_size.max(dst_size);
        let delta_size = max_size - src_size.min(dst_size);
        if max_size * (MAX_SCORE - MINIMUM_SCORE as u64) < delta_size * MAX_SCORE {
            return Ok(0);
        }
        let src = self.spans(source.leaf.id, &source.path)?;
        let target_path = self.path.clone();
        let dst = self.spans(target.id, &target_path)?;
        if dst_size == 0 {
            return Ok(0);
        }
        Ok((copied(&src, &dst) * MAX_SCORE / max_size) as i64)
    }

    fn spans(&mut self, id: ObjectId, path: &[u8]) -> Result<std::rc::Rc<Spans>, String> {
        let hashed = match self.spans.get(&id) {
            Some(hashed) => hashed.clone(),
            None => {
                let object = self.log.repo.find_object(id).map_err(|e| e.to_string())?;
                let data = &object.data;
                let crlf = data.windows(2).any(|pair| pair == b"\r\n");
                let hashed = std::rc::Rc::new(Hashed {
                    nul: data[..data.len().min(8000)].contains(&0),
                    binary: std::rc::Rc::new(hash_chars(data, false)),
                    text: crlf.then(|| std::rc::Rc::new(hash_chars(data, true))),
                });
                self.spans.insert(id, hashed.clone());
                hashed
            }
        };
        // hash_chars 只对文本跳过 CRLF 里的 CR，没有 CRLF 时两种算法一样。
        let Some(text) = &hashed.text else { return Ok(hashed.binary.clone()) };
        Ok(if self.is_binary(path, hashed.nul)? { hashed.binary.clone() } else { text.clone() })
    }

    /// diff.c `diff_filespec_is_binary`：普通文件先看 `diff` 属性选中的驱动（userdiff.c
    /// `userdiff_find_by_path`：设为真是文本、取消是二进制、具名驱动看 `diff.<name>.binary`），
    /// 驱动没说的按 `buffer_is_binary`（前 8000 字节里有没有 NUL）。属性来源同 `git check-attr`；
    /// 非空的系统级属性文件让位给 git。
    fn is_binary(&mut self, path: &[u8], nul: bool) -> Result<bool, String> {
        if self.attributes.is_none() {
            let system = crate::lfs::system_attributes().ok_or("GIT_ATTR_SYSTEM unknown")?;
            match std::fs::read(&system) {
                Ok(content) if content.iter().any(|b| !b.is_ascii_whitespace()) => {
                    return Err("system gitattributes".into());
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
            let index = self.log.repo.index_or_empty().map_err(|e| e.to_string())?;
            let stack = self
                .log
                .repo
                .attributes_only(&index, gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping)
                .map_err(|e| e.to_string())?;
            self.attributes = Some(stack);
        }
        let stack = self.attributes.as_mut().expect("initialised above");
        let mut outcome = stack.selected_attribute_matches(["diff"]);
        stack
            .at_entry(gix::bstr::BStr::new(path), Some(gix::index::entry::Mode::FILE))
            .map_err(|e| e.to_string())?
            .matching_attributes(&mut outcome);
        let state = outcome.iter_selected().next().map(|m| m.assignment.state.to_owned());
        Ok(match state {
            Some(gix::attrs::State::Set) => false,
            Some(gix::attrs::State::Unset) => true,
            Some(gix::attrs::State::Value(name)) => {
                let key = format!("diff.{}.binary", name.as_ref().as_bstr());
                match self.log.repo.config_snapshot().try_boolean(key.as_str()) {
                    Ok(Some(binary)) => binary,
                    Err(error) => return Err(error.to_string()),
                    Ok(None) => nul,
                }
            }
            Some(gix::attrs::State::Unspecified) | None => nul,
        })
    }
}

/// 一个 blob 的两种切块结果：没有 CRLF 时只有一种。
struct Hashed {
    nul: bool,
    binary: std::rc::Rc<Spans>,
    text: Option<std::rc::Rc<Spans>>,
}

/// diffcore-rename.c `struct diff_score`（`dst` 只有一个，省略）。
#[derive(Debug, Clone, Copy)]
struct Candidate {
    score: i64,
    name_score: i32,
    src: usize,
}

/// diffcore-rename.c `score_compare`：空位沉底，分数高的在前，同分时基名相同的在前。
fn score_compare(a: &Option<Candidate>, b: &Option<Candidate>) -> i64 {
    match (a, b) {
        (None, b) => i64::from(b.is_some()),
        (Some(_), None) => -1,
        (Some(a), Some(b)) if a.score == b.score => i64::from(b.name_score - a.name_score),
        (Some(a), Some(b)) => b.score - a.score,
    }
}

/// diffcore-rename.c `record_if_better`：找出最差的那一格，新的严格更好才替换。
fn record_if_better(slots: &mut [Option<Candidate>; CANDIDATES], candidate: Candidate) {
    let mut worst = 0;
    for index in 1..CANDIDATES {
        if score_compare(&slots[index], &slots[worst]) > 0 {
            worst = index;
        }
    }
    if score_compare(&slots[worst], &Some(candidate)) > 0 {
        slots[worst] = Some(candidate);
    }
}

/// diffcore-rename.c `basename_same`。
fn basename_same(src: &[u8], dst: &[u8]) -> bool {
    let (mut src_len, mut dst_len) = (src.len(), dst.len());
    while src_len > 0 && dst_len > 0 {
        src_len -= 1;
        dst_len -= 1;
        let (c1, c2) = (src[src_len], dst[dst_len]);
        if c1 != c2 {
            return false;
        }
        if c1 == b'/' {
            return true;
        }
    }
    (src_len == 0 || src[src_len - 1] == b'/') && (dst_len == 0 || dst[dst_len - 1] == b'/')
}

/// diffcore-delta.c `hash_chars`：按行（最长 64 字节）切块，块哈希取模 HASHBASE，同哈希的字节数相加。
fn hash_chars(data: &[u8], is_text: bool) -> Spans {
    const HASHBASE: u32 = 107927;
    let mut counts: HashMap<u32, u32> = HashMap::new();
    let (mut n, mut accum1, mut accum2) = (0u32, 0u32, 0u32);
    let mut index = 0;
    while index < data.len() {
        let c = u32::from(data[index]);
        index += 1;
        let old_1 = accum1;
        if is_text && c == u32::from(b'\r') && index < data.len() && data[index] == b'\n' {
            continue;
        }
        accum1 = (accum1 << 7) ^ (accum2 >> 25);
        accum2 = (accum2 << 7) ^ (old_1 >> 25);
        accum1 = accum1.wrapping_add(c);
        n += 1;
        if n < 64 && c != u32::from(b'\n') {
            continue;
        }
        let hashval = accum1.wrapping_add(accum2.wrapping_mul(0x61)) % HASHBASE;
        *counts.entry(hashval).or_default() += n;
        n = 0;
        accum1 = 0;
        accum2 = 0;
    }
    if n > 0 {
        let hashval = accum1.wrapping_add(accum2.wrapping_mul(0x61)) % HASHBASE;
        *counts.entry(hashval).or_default() += n;
    }
    let mut spans: Spans = counts.into_iter().collect();
    spans.sort_unstable();
    spans
}

/// diffcore-delta.c `diffcore_count_changes` 的 `src_copied`：同一哈希两边字节数取小的相加。
fn copied(src: &Spans, dst: &Spans) -> u64 {
    let (mut i, mut j, mut copied) = (0, 0, 0u64);
    while i < src.len() && j < dst.len() {
        match src[i].0.cmp(&dst[j].0) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                copied += u64::from(src[i].1.min(dst[j].1));
                i += 1;
                j += 1;
            }
        }
    }
    copied
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(r: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(r).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// 提交时间固定递增，遍历顺序与时区无关。
    fn commit(r: &Path, message: &str, at: &mut u64) {
        *at += 60;
        let date = format!("@{at} +0000");
        let out = Command::new("git")
            .arg("-C")
            .arg(r)
            .args(["commit", "-q", "--allow-empty", "-m", message])
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "测试者"]);
        (d, r)
    }

    fn summaries(commits: &[CommitDetails]) -> Vec<String> {
        commits.iter().map(|commit| commit.to_info().summary).collect()
    }

    /// 进程内结果必须作答，并且与 `git log --follow` 逐字节一致（同一份解析）。
    fn assert_same(r: &Path, path: &str) -> Vec<CommitDetails> {
        let via_git = follow_via_git(r, path, 1000).unwrap();
        let fast = follow_in_process(r, path, 1000).unwrap_or_else(|reason| panic!("{path}: refused: {reason}"));
        assert_eq!(fast, via_git, "{path}");
        for max in [1, 2, 3] {
            assert_eq!(follow_in_process(r, path, max).unwrap(), via_git[..max.min(via_git.len())], "{path} max {max}");
        }
        via_git
    }

    fn lines(prefix: &str, count: usize) -> String {
        (0..count).map(|i| format!("{prefix} line {i:03}\n")).collect()
    }

    #[test]
    fn 文件历史跨重命名并按页取() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        std::fs::write(r.join("a.txt"), "1\n2\n3\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "第一次提交", &mut at);
        std::fs::write(r.join("a.txt"), "1\n2改\n3\n").unwrap();
        std::fs::write(r.join("b.txt"), "新文件\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "第二次提交", &mut at);
        git(&r, &["mv", "a.txt", "renamed.txt"]);
        commit(&r, "改名", &mut at);
        std::fs::write(r.join("renamed.txt"), "1\n2改\n3改\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "改名后再改", &mut at);
        std::fs::write(r.join("b.txt"), "别的文件\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "无关提交", &mut at);

        let all = assert_same(&r, "renamed.txt");
        assert_eq!(summaries(&all), ["改名后再改", "改名", "第二次提交", "第一次提交"], "跟着重命名回到 a.txt 的历史");
        let page = file_history(&r, "renamed.txt", 0, 2, None).unwrap();
        assert_eq!(page.commits, all[..2], "第一页是最新的两条");
        assert!(page.has_more, "多取的一条说明还有");
        let page = file_history(&r, "renamed.txt", 2, 2, None).unwrap();
        assert_eq!(page.commits, all[2..], "第二页接着第一页，不会因为 --follow 错位");
        assert!(!page.has_more, "取到头了");
        assert!(
            file_history(&r, "missing.txt", 0, 10, None).unwrap().commits.is_empty(),
            "不存在的路径是空历史，不是错误"
        );
    }

    #[test]
    fn 文件历史跟随改名复制合并与根提交() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        std::fs::create_dir_all(r.join("src/deep")).unwrap();
        std::fs::write(r.join("src/one.txt"), lines("one", 30)).unwrap();
        std::fs::write(r.join("src/other.txt"), lines("other", 30)).unwrap();
        std::fs::write(r.join("src/deep/same.txt"), "same\n").unwrap();
        std::fs::write(r.join("empty.txt"), "").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        // 改名并修改（不精确匹配）
        git(&r, &["mv", "src/one.txt", "src/two.txt"]);
        std::fs::write(r.join("src/two.txt"), lines("one", 30) + &lines("added", 8)).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "rename with edit", &mut at);
        // 复制（来源还在）：find_copies_harder 让未修改的文件也当来源
        std::fs::copy(r.join("src/other.txt"), r.join("copied.txt")).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "copy", &mut at);
        // 精确改名到别的目录，同内容的文件不止一个：基名相同的优先
        std::fs::write(r.join("src/same.txt"), "same\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "duplicate content", &mut at);
        std::fs::create_dir_all(r.join("moved")).unwrap();
        git(&r, &["mv", "src/deep/same.txt", "moved/same.txt"]);
        commit(&r, "move", &mut at);
        // 空文件改名
        git(&r, &["mv", "empty.txt", "empty2.txt"]);
        commit(&r, "rename empty", &mut at);
        // 多次改名
        git(&r, &["mv", "src/two.txt", "three.txt"]);
        commit(&r, "rename again", &mut at);
        // 侧枝改这个文件后合并：合并提交本身不出现，侧枝上的提交出现
        git(&r, &["checkout", "-q", "-b", "side"]);
        std::fs::write(r.join("three.txt"), lines("one", 30) + &lines("side", 9)).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "side edit", &mut at);
        git(&r, &["checkout", "-q", "main"]);
        std::fs::write(r.join("unrelated.txt"), "x\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "main edit", &mut at);
        at += 60;
        let date = format!("@{at} +0000");
        let out = Command::new("git")
            .arg("-C")
            .arg(&r)
            .args(["merge", "-q", "--no-ff", "-m", "merge side", "side"])
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        // 删除再新建同名文件
        git(&r, &["rm", "-q", "src/other.txt"]);
        commit(&r, "delete other", &mut at);
        std::fs::write(r.join("src/other.txt"), "brand new\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "recreate other", &mut at);

        assert_eq!(
            summaries(&assert_same(&r, "three.txt")),
            ["side edit", "rename again", "rename with edit", "root"],
            "两次改名都跟上，合并提交不出现"
        );
        assert_eq!(summaries(&assert_same(&r, "copied.txt")), ["copy", "root"], "复制来源的历史");
        assert_eq!(summaries(&assert_same(&r, "moved/same.txt")), ["move", "root"]);
        assert_eq!(summaries(&assert_same(&r, "empty2.txt")), ["rename empty", "root"], "空文件也按精确匹配改名");
        assert_eq!(summaries(&assert_same(&r, "src/other.txt")), ["recreate other", "delete other", "root"]);
        assert_same(&r, "src/same.txt");
        assert_same(&r, "unrelated.txt");
        assert_same(&r, "gone.txt");
    }

    #[test]
    fn 暂存的重命名用原路径的历史() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        std::fs::write(r.join("old.txt"), "content\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "add old", &mut at);
        git(&r, &["mv", "old.txt", "new.txt"]);
        let page = file_history(&r, "new.txt", 0, 10, None).unwrap();
        assert_eq!(summaries(&page.commits), ["add old"], "HEAD 里还没有 new.txt，改看暂存重命名前的 old.txt");
    }

    #[test]
    fn 目录与子模块交给git() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        std::fs::create_dir_all(r.join("dir")).unwrap();
        std::fs::write(r.join("dir/f.txt"), "f\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "dir", &mut at);
        assert!(follow_in_process(&r, "dir", 10).is_err(), "目录的 pathspec 含义不同");
        assert!(follow_in_process(&r, "d*", 10).is_err(), "通配符");
        assert_eq!(follow(&r, "dir", 10).unwrap(), follow_via_git(&r, "dir", 10).unwrap());
    }

    #[test]
    fn 相似度估计与git的阈值一致() {
        // 90 字节改成 153 字节：delta 63 大于较小一侧的一半但小于较大一侧的一半，git 仍认作改名
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        std::fs::write(r.join("a.txt"), lines("x", 6)).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "c1", &mut at);
        std::fs::remove_file(r.join("a.txt")).unwrap();
        std::fs::write(r.join("b.txt"), lines("x", 6) + &lines("y", 4)).unwrap();
        git(&r, &["add", "-A"]);
        commit(&r, "c2", &mut at);
        assert_eq!(summaries(&assert_same(&r, "b.txt")), ["c2", "c1"]);
        // CRLF 内容、没有属性文件：按文本跳过 CR
        std::fs::write(r.join("crlf.txt"), lines("z", 10).replace('\n', "\r\n")).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "crlf", &mut at);
        std::fs::remove_file(r.join("crlf.txt")).unwrap();
        std::fs::write(r.join("crlf2.txt"), lines("z", 10) + &lines("w", 2)).unwrap();
        git(&r, &["add", "-A"]);
        commit(&r, "crlf moved", &mut at);
        let via_git = follow_via_git(&r, "crlf2.txt", 100).unwrap();
        match follow_in_process(&r, "crlf2.txt", 100) {
            Ok(fast) => assert_eq!(fast, via_git),
            Err(reason) => assert!(reason.contains("gitattributes"), "{reason}"),
        }
    }

    /// 上千个提交、中途多次改名：分批并行查路径、改名后重查本批剩余的那段，结果仍与 git 一致。
    #[test]
    fn 长历史分批并行与改名重查() {
        let (_d, r) = repo();
        let mut stream = String::new();
        let mut path = "docs/notes.txt".to_string();
        let mut content = lines("notes", 20);
        for i in 0..1200u32 {
            let at = 1_700_000_000 + u64::from(i) * 60;
            stream.push_str(&format!(
                "commit refs/heads/main\nmark :{}\ncommitter T <t@t.t> {at} +0000\ndata <<EOF\nc{i}\nEOF\n",
                i + 1
            ));
            if i > 0 {
                stream.push_str(&format!("from :{i}\n"));
            }
            let mut files: Vec<(String, String)> = Vec::new();
            if i % 300 == 150 {
                // 改名：中途换目录，内容也改一点，走不精确匹配
                stream.push_str(&format!("D {path}\n"));
                path = format!("moved{}/notes-{i}.txt", i / 300);
                content.push_str(&format!("renamed at {i}\n"));
                files.push((path.clone(), content.clone()));
            } else if i % 7 == 0 {
                content.push_str(&format!("edit {i}\n"));
                files.push((path.clone(), content.clone()));
            }
            files.push((format!("other/{}.txt", i % 40), format!("other {i}\n")));
            for (name, body) in files {
                stream.push_str(&format!("M 100644 inline {name}\ndata {}\n{body}\n", body.len()));
            }
        }
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&r)
            .args(["fast-import", "--quiet"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write as _;
        child.stdin.take().unwrap().write_all(stream.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        git(&r, &["reset", "-q", "--hard", "main"]);
        let all = assert_same(&r, &path);
        assert!(all.len() > 170, "跨过三次改名回到最初的路径：{}", all.len());
        for max in [100, 101, 172, 400] {
            assert_eq!(follow_in_process(&r, &path, max).unwrap(), all[..max.min(all.len())], "max {max}");
        }
        assert_same(&r, "other/3.txt");
        assert_same(&r, "docs/notes.txt");

        // 带游标翻页：页边正好落在改名提交上（改名提交是上一页最后一条，或下一页第一条），
        // 游标停在一批的中间、改名后重查队列里剩下的提交，拼起来仍是 git 全量。
        let renames: Vec<usize> = all
            .iter()
            .enumerate()
            .filter(|(_, commit)| ["c150", "c450", "c750", "c1050"].contains(&commit.to_info().summary.as_str()))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(renames.len(), 4, "四次改名都在历史里");
        let mut limits = vec![1, 2, 3, 7, 50, 100];
        for index in &renames {
            limits.extend([*index, index + 1]);
        }
        for limit in limits.into_iter().filter(|limit| *limit > 0) {
            let (resumed, pages) = page_through(&r, &path, limit, &all);
            assert_eq!(resumed, pages - 1, "limit {limit}: 除第一页外都接着游标走");
        }
    }

    /// 带游标逐页翻到底：每一页都必须是 git 全量的对应切片。返回 (接着游标走的页数, 总页数)。
    fn page_through(r: &Path, path: &str, limit: usize, full: &[CommitDetails]) -> (usize, usize) {
        let (mut cursor, mut shown, mut pages, mut resumed) = (None::<String>, 0, 0, 0);
        loop {
            let page = file_history(r, path, shown, limit, cursor.as_deref()).unwrap();
            let end = (shown + limit).min(full.len());
            assert_eq!(page.commits[..], full[shown.min(end)..end], "{path} limit {limit} page {pages}");
            assert_eq!(page.has_more, full.len() > shown + limit, "{path} limit {limit} page {pages}");
            resumed += usize::from(page.resumed);
            pages += 1;
            shown += page.commits.len();
            if !page.has_more {
                assert!(page.cursor.is_none(), "没有下一页就不留游标");
                return (resumed, pages);
            }
            cursor = page.cursor;
        }
    }

    fn commit_at(r: &Path, args: &[&str], at: &mut u64) {
        *at += 60;
        let date = format!("@{at} +0000");
        let out = Command::new("git")
            .arg("-C")
            .arg(r)
            .args(args)
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// 侧分支上的提交比主线上分页处的提交更早（GitLens `<sha>^` 续走会漏掉的那种），中间还有改名，
    /// 历史一直到根提交。
    fn side_branch_repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let (d, r) = repo();
        let mut at = 1_700_000_000;
        let body = |top: &str, bottom: &str| format!("{top}\n{}{bottom}\n", lines("mid", 30));
        std::fs::write(r.join("f.txt"), body("top0", "bottom0")).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        git(&r, &["checkout", "-q", "-b", "side"]);
        for i in 1..=3 {
            std::fs::write(r.join("f.txt"), body(&format!("side{i}"), "bottom0")).unwrap();
            git(&r, &["add", "."]);
            commit(&r, &format!("side {i}"), &mut at);
        }
        git(&r, &["checkout", "-q", "main"]);
        for i in 1..=3 {
            std::fs::write(r.join("f.txt"), body("top0", &format!("main{i}"))).unwrap();
            git(&r, &["add", "."]);
            commit(&r, &format!("main {i}"), &mut at);
        }
        commit_at(&r, &["merge", "-q", "--no-ff", "-m", "merge side", "side"], &mut at);
        git(&r, &["mv", "f.txt", "g.txt"]);
        commit(&r, "rename", &mut at);
        std::fs::write(r.join("g.txt"), body("side3", "after")).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "after rename", &mut at);
        (d, r)
    }

    #[test]
    fn 游标翻页覆盖合并侧枝改名与根提交() {
        let (_d, r) = side_branch_repo();
        let all = assert_same(&r, "g.txt");
        assert_eq!(
            summaries(&all),
            ["after rename", "rename", "main 3", "main 2", "main 1", "side 3", "side 2", "side 1", "root"],
            "侧枝上的旧提交和根提交都在"
        );
        for limit in 1..=all.len() + 1 {
            let (resumed, pages) = page_through(&r, "g.txt", limit, &all);
            assert_eq!(resumed, pages - 1, "limit {limit}");
        }
        // log.showRoot 关掉：根提交不显示；翻页中途改了它，游标作废、从头走。
        git(&r, &["config", "log.showRoot", "false"]);
        let without_root = assert_same(&r, "g.txt");
        assert_eq!(without_root.len(), all.len() - 1);
        page_through(&r, "g.txt", 2, &without_root);
        let first = file_history(&r, "g.txt", 0, 4, None).unwrap();
        git(&r, &["config", "log.showRoot", "true"]);
        let second = file_history(&r, "g.txt", 4, 4, first.cursor.as_deref()).unwrap();
        assert!(!second.resumed, "showRoot 变了");
        assert_eq!(second.commits, all[4..8]);
    }

    #[test]
    fn 翻页中途仓库变化时游标作废() {
        let (_d, r) = side_branch_repo();
        let mut at = 1_800_000_000;
        let all = follow_via_git(&r, "g.txt", 1000).unwrap();
        let first = file_history(&r, "g.txt", 0, 3, None).unwrap();
        assert!(first.cursor.is_some());

        // 无效、页码不对、别的文件、过期、用过一次的游标：都从头走，结果不变。
        for token in ["", "nope"] {
            let page = file_history(&r, "g.txt", 3, 3, Some(token)).unwrap();
            assert!(!page.resumed && page.commits == all[3..6], "{token:?}");
        }
        let token = file_history(&r, "g.txt", 0, 3, None).unwrap().cursor.unwrap();
        let page = file_history(&r, "g.txt", 4, 3, Some(&token)).unwrap();
        assert!(!page.resumed && page.commits == all[4..7], "页码对不上");
        let token = file_history(&r, "g.txt", 0, 3, None).unwrap().cursor.unwrap();
        let page = file_history(&r, "f.txt", 3, 3, Some(&token)).unwrap();
        assert!(!page.resumed && page.commits == follow_via_git(&r, "f.txt", 6).unwrap()[3..], "别的文件");
        let token = file_history(&r, "g.txt", 0, 3, None).unwrap().cursor.unwrap();
        cursors::age(&token);
        assert!(!file_history(&r, "g.txt", 3, 3, Some(&token)).unwrap().resumed, "过期");
        let token = file_history(&r, "g.txt", 0, 3, None).unwrap().cursor.unwrap();
        assert!(file_history(&r, "g.txt", 3, 3, Some(&token)).unwrap().resumed);
        let again = file_history(&r, "g.txt", 3, 3, Some(&token)).unwrap();
        assert!(!again.resumed && again.commits == all[3..6], "游标只能用一次");

        // 同一文件重新加载第一页会替换旧游标；内存里的游标数有上限。
        let before = cursors::len();
        for _ in 0..3 {
            file_history(&r, "g.txt", 0, 3, None).unwrap();
        }
        assert_eq!(cursors::len(), before, "同一文件只留最新的游标");
        for i in 0..cursors::MAX + 3 {
            std::fs::write(r.join(format!("n{i}.txt")), format!("{i}\n")).unwrap();
        }
        git(&r, &["add", "."]);
        commit(&r, "many", &mut at);
        for i in 0..cursors::MAX + 3 {
            std::fs::write(r.join(format!("n{i}.txt")), format!("{i} again\n")).unwrap();
        }
        git(&r, &["add", "."]);
        commit(&r, "many again", &mut at);
        for i in 0..cursors::MAX + 3 {
            assert!(file_history(&r, &format!("n{i}.txt"), 0, 1, None).unwrap().cursor.is_some());
        }
        assert_eq!(cursors::len(), cursors::MAX);

        // commit-graph 在两页之间重写或删掉：队列里的提交按新的仓库重新定位，仍接着走。
        let all = follow_via_git(&r, "g.txt", 1000).unwrap();
        let first = file_history(&r, "g.txt", 0, 3, None).unwrap();
        git(&r, &["commit-graph", "write", "--reachable"]);
        let second = file_history(&r, "g.txt", 3, 3, first.cursor.as_deref()).unwrap();
        assert!(second.resumed && second.commits == all[3..6], "写了 commit-graph");
        std::fs::remove_file(r.join(".git/objects/info/commit-graph")).unwrap();
        let third = file_history(&r, "g.txt", 6, 3, second.cursor.as_deref()).unwrap();
        assert!(third.resumed && third.commits == all[6..], "删了 commit-graph");

        // 新提交改了这个文件：HEAD 移动，游标作废，第二页是新的 git 全量里的那一段（会和第一页重一条）。
        let first = file_history(&r, "g.txt", 0, 3, None).unwrap();
        std::fs::write(r.join("g.txt"), "rewritten\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "new commit", &mut at);
        let all = follow_via_git(&r, "g.txt", 1000).unwrap();
        let second = file_history(&r, "g.txt", 3, 3, first.cursor.as_deref()).unwrap();
        assert!(!second.resumed && second.commits == all[3..6], "HEAD 移动后从头走");
        // 新提交不碰这个文件：仍然作废（HEAD 不同），结果与 git 一致。
        let first = file_history(&r, "g.txt", 0, 3, None).unwrap();
        std::fs::write(r.join("unrelated.txt"), "x\n").unwrap();
        git(&r, &["add", "."]);
        commit(&r, "unrelated", &mut at);
        let all = follow_via_git(&r, "g.txt", 1000).unwrap();
        let second = file_history(&r, "g.txt", 3, 3, first.cursor.as_deref()).unwrap();
        assert!(!second.resumed && second.commits == all[3..6]);
        // 引用变了但 HEAD 没动：接着走，装饰按现在的引用渲染。
        let first = file_history(&r, "g.txt", 0, 3, None).unwrap();
        git(&r, &["tag", "v1", "HEAD~3"]);
        git(&r, &["branch", "-f", "side", "HEAD~4"]);
        let all = follow_via_git(&r, "g.txt", 1000).unwrap();
        let second = file_history(&r, "g.txt", 3, 3, first.cursor.as_deref()).unwrap();
        assert!(second.resumed);
        assert_eq!(second.commits, all[3..6], "装饰跟上新的标签与分支");
        // HEAD 换到别的分支：从头走。
        let first = file_history(&r, "g.txt", 0, 3, None).unwrap();
        git(&r, &["checkout", "-q", "side"]);
        let all = follow_via_git(&r, "g.txt", 1000).unwrap();
        let second = file_history(&r, "g.txt", 3, 3, first.cursor.as_deref()).unwrap();
        assert!(!second.resumed && second.commits[..] == all[3.min(all.len())..6.min(all.len())]);
    }

    #[test]
    fn 读过gitattributes的遍历不留游标() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        std::fs::write(r.join("crlf.txt"), lines("z", 10).replace('\n', "\r\n")).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "crlf", &mut at);
        std::fs::write(r.join("crlf.txt"), lines("z", 11).replace('\n', "\r\n")).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "crlf edit", &mut at);
        std::fs::remove_file(r.join("crlf.txt")).unwrap();
        std::fs::write(r.join("crlf2.txt"), lines("z", 11) + &lines("w", 2)).unwrap();
        git(&r, &["add", "-A"]);
        commit(&r, "crlf moved", &mut at);
        let all = follow_via_git(&r, "crlf2.txt", 100).unwrap();
        let page = file_history(&r, "crlf2.txt", 0, 1, None).unwrap();
        assert_eq!(page.commits, all[..1]);
        assert!(page.has_more && page.cursor.is_none(), "改名检测按属性判断过文本，属性可能在下一页前改掉");
        assert_eq!(file_history(&r, "crlf2.txt", 1, 5, None).unwrap().commits, all[1..]);
    }

    #[test]
    fn hash_chars_按行切块() {
        assert_eq!(copied(&hash_chars(b"a\nb\n", false), &hash_chars(b"a\nb\nc\n", false)), 4);
        assert_eq!(hash_chars(b"a\r\n", true), hash_chars(b"a\n", false), "文本里 CRLF 的 CR 不计");
        assert!(basename_same(b"x/same.txt", b"same.txt") && !basename_same(b"same.txt", b"xsame.txt"));
    }

    /// 真实仓库抽样对照：`GITCUB_FILE_HISTORY_REPOS=/path/a:/path/b cargo test … -- --ignored`。
    /// 每个仓库按 ls-files 等距抽样，加上 HEAD 最近改过的文件，进程内结果必须与 git 逐字节一致。
    #[test]
    #[ignore]
    fn 真实仓库文件历史与git一致() {
        let repos = std::env::var("GITCUB_FILE_HISTORY_REPOS").unwrap_or_default();
        let samples: usize =
            std::env::var("GITCUB_FILE_HISTORY_SAMPLES").ok().and_then(|n| n.parse().ok()).unwrap_or(40);
        for repo in repos.split(':').filter(|path| !path.is_empty()) {
            let root = Path::new(repo);
            let files: Vec<String> =
                git(root, &["ls-files", "-z"]).split('\0').filter(|f| !f.is_empty()).map(str::to_string).collect();
            let step = (files.len() / samples.max(1)).max(1);
            let mut picked: Vec<String> = files.iter().step_by(step).cloned().collect();
            picked.extend(
                git(root, &["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])
                    .split('\0')
                    .filter(|f| !f.is_empty())
                    .map(str::to_string),
            );
            let (mut answered, mut refused, mut paged, mut continued) = (0, 0, 0, 0);
            for file in &picked {
                let via_git = follow_via_git(root, file, 1 << 30).unwrap();
                match follow_in_process(root, file, 1 << 30) {
                    Ok(fast) => {
                        assert_eq!(fast.len(), via_git.len(), "{repo} {file}");
                        assert_eq!(fast, via_git, "{repo} {file}");
                        answered += 1;
                        // 带游标逐页翻（前端的一页 100 条，再加一个和批大小错开的页长），拼起来是 git 全量。
                        for limit in [100, 37] {
                            if via_git.len() > limit {
                                // 读过 gitattributes 的不留游标，所以只统计、不要求每页都接着走。
                                let (resumed, pages) = page_through(root, file, limit, &via_git);
                                paged += pages;
                                continued += resumed;
                            }
                        }
                    }
                    Err(reason) => {
                        eprintln!("{repo} {file}: refused: {reason}");
                        refused += 1;
                    }
                }
            }
            eprintln!(
                "{repo}: {answered} files identical, {refused} refused, {paged} pages identical ({continued} resumed from cursors)"
            );
        }
    }
}
