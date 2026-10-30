//! 提交图：泳道分配。
//!
//! GitHub Desktop 没有这个；GitKraken / Fork / GitLens 靠它立足。算法是标准的
//! 「泳道」做法，本身不复杂，难的是把它和提交列表对齐成一行一行，所以这里只
//! 输出**每一行的状态快照**，连线怎么画交给渲染端：
//!
//!   lane      这个提交画在第几列
//!   lanes     处理完这一行之后，每条泳道上「下一个等着的提交」
//!   streams   每条泳道属于哪条「色流」——开泳道时分配，泳道左移、翻页都带着走
//!
//! 渲染端拿相邻两行的 lanes / streams 一比就知道该画竖线还是斜线，不需要再懂算法。
//! 这样拆的另一个好处是可测：算法这一侧是纯函数，不碰 DOM。
//!
//! 规则对照的是两份 MIT 实现（commit 见 tests/conformance/README.md）：
//! VS Code `scmHistory.ts` 的 `toISCMHistoryItemViewModelArray` / `renderSCMHistoryItemGraph`，
//! lazygit `pkg/gui/presentation/graph/graph.go` 的 `getNextPipes`。
//!
//!   - 提交落在**第一条**等它的泳道上（lazygit「place it right under the first instance」，
//!     VS Code `inputSwimlanes.findIndex`）；其余等它的泳道在这一行汇入后消失，
//!     右侧泳道左移补位（VS Code 不输出已汇入的 swimlane；lazygit「moving left to fill in a blank spot」）。
//!   - 第一个父提交接着占用本泳道、沿用它的色流（VS Code 首个 parent 继承 `node.color`）。
//!   - 其余父提交：已有泳道在等它就直接连过去，不再开第二条（VS Code 渲染时按
//!     `findLastIndex(outputSwimlanes, parentId)` 找父提交所在的输出泳道画 `-\`，
//!     所以连线由父提交所在泳道决定，而不是由泳道差异推断）；没有才开新泳道、分配新色流。
//!   - 根提交结束自己的泳道。
//!
//! 翻页：`GraphCursor` 带着上一页末尾的泳道、色流和下一个色流编号，下一页从这里接着算，
//! 和一次算完逐字节相同（见测试）。
//!
//! 行的顺序由 [`date_order`] 给出：git `--date-order` 的一比一移植，整条序列按仓库缓存（[`order`]），
//! 泳道算法只要求「子提交在父提交之前」，这个顺序保证它。

use crate::history::CommitInfo;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub commit: CommitInfo,
    /// 这个提交画在第几列
    pub lane: usize,
    /// 处理完这一行之后各泳道上等待的提交 sha。泳道汇入后即收掉，所以不会出现空洞，
    /// `Option` 只是沿用原有的前端契约
    pub lanes: Vec<Option<String>>,
    /// 指向这个提交的分支 / 标签名：HEAD 所在分支在前，然后是本地分支、远端分支、标签
    pub refs: Vec<String>,
    /// 这个提交所在泳道的色流
    pub stream: u32,
    /// 与 `lanes` 一一对应：每条泳道的色流
    pub streams: Vec<u32>,
    /// HEAD 指向这个提交时，HEAD 所在分支的短名；分离 HEAD 时是 `HEAD`
    pub head: Option<String>,
    /// 与 `refs` 里的分支同序、按完整引用名给出的分支：同短名的本地分支和远端跟踪分支
    /// （本地 `origin/x` 与 `refs/remotes/origin/x`）在 `refs` 里分不开，靠它区分
    pub branches: Vec<GraphBranch>,
    /// 贮藏行：`stash@{n}` 的 n（GitLens `stashNumber`）。贮藏行的 `commit.parent_sh_as` 只有
    /// 基提交，索引与未跟踪文件两个内部父提交不成行
    pub stash: Option<usize>,
    /// HEAD 能走到这个提交（`git log HEAD` 会列出它）。改写历史的操作只对这些行成立
    pub on_head: bool,
}

/// 提交图上的一个分支装饰。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphBranch {
    /// 完整引用名：`refs/heads/…` 或 `refs/remotes/…`
    pub reference: String,
    /// 远端跟踪分支所属的远端，按最长的已配置远端拆分（与 `branch::list` 同一规则），
    /// 名字里带 `/` 的远端（GitLab 子组 fork）保持完整；本地分支为 `None`
    pub remote: Option<String>,
}

/// 一页算完之后的泳道状态，下一页从这里接着算。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCursor {
    /// 每条泳道等待的提交 sha
    pub lanes: Vec<String>,
    /// 与 `lanes` 一一对应的色流
    pub streams: Vec<u32>,
    /// 下一条新泳道拿到的色流编号
    pub next_stream: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    pub rows: Vec<GraphRow>,
    pub cursor: GraphCursor,
    /// 这一页已经是最后一页，后面没有提交了
    pub done: bool,
}

/// 只做泳道分配，不碰 git：从 `cursor` 接着算一批，算完后 `cursor` 变成这批末尾的状态。
/// `commits` 必须已经按「子提交在父提交之前」排好序，父子关系取自 `CommitInfo::parent_sh_as`。
pub fn continue_lanes(cursor: &mut GraphCursor, commits: Vec<CommitInfo>) -> Vec<GraphRow> {
    debug_assert_eq!(cursor.lanes.len(), cursor.streams.len(), "泳道和色流必须一一对应");
    let mut out = Vec::with_capacity(commits.len());

    for commit in commits {
        // 这个提交占哪条泳道：第一条在等它的；没有就在最右边开一条新的
        let lane = match cursor.lanes.iter().position(|sha| *sha == commit.sha) {
            Some(i) => i,
            None => {
                cursor.lanes.push(commit.sha.clone());
                cursor.streams.push(cursor.next_stream);
                cursor.next_stream += 1;
                cursor.lanes.len() - 1
            }
        };
        let stream = cursor.streams[lane];

        // 其余等着它的泳道在这一行汇入，收掉；它们都在 `lane` 右侧，所以 `lane` 不动
        let mut index = cursor.lanes.len();
        while index > lane + 1 {
            index -= 1;
            if cursor.lanes[index] == commit.sha {
                cursor.lanes.remove(index);
                cursor.streams.remove(index);
            }
        }

        // 第一个父提交接着占用本泳道；根提交结束泳道
        match commit.parent_sh_as.first() {
            Some(parent) => cursor.lanes[lane] = parent.clone(),
            None => {
                cursor.lanes.remove(lane);
                cursor.streams.remove(lane);
            }
        }
        // 其余父提交：已经有泳道在等的直接连过去，否则开新泳道
        for parent in commit.parent_sh_as.iter().skip(1) {
            if cursor.lanes.iter().any(|sha| sha == parent) {
                continue;
            }
            cursor.lanes.push(parent.clone());
            cursor.streams.push(cursor.next_stream);
            cursor.next_stream += 1;
        }

        out.push(GraphRow {
            commit,
            lane,
            lanes: cursor.lanes.iter().cloned().map(Some).collect(),
            refs: Vec::new(),
            stream,
            streams: cursor.streams.clone(),
            head: None,
            branches: Vec::new(),
            stash: None,
            on_head: false,
        });
    }
    out
}

/// 分支装饰：每个提交上挂着哪些分支，以及 HEAD 指向哪里。
struct Decorations {
    /// 提交 sha → 指向它的分支：（短名，结构化引用）
    branches: HashMap<String, Vec<(String, GraphBranch)>>,
    /// HEAD 所指提交的 sha 和显示名（分支短名，分离时为 `HEAD`）
    head: Option<(String, String)>,
}

/// 标签走 history 的引用索引缓存（标签是引用里的大头，Desktop 仓库 688 个）；
/// 本地与远端分支数量小、直接指向提交，每页读一次即可。
fn decorations(repo: &gix::Repository) -> Decorations {
    let mut branches: HashMap<String, Vec<(String, GraphBranch)>> = HashMap::new();
    let remote_names: Vec<String> = repo.remote_names().into_iter().map(|name| name.to_string()).collect();
    let remote_names: Vec<&str> = remote_names.iter().map(String::as_str).collect();
    if let Ok(platform) = repo.references()
        && let Ok(local) = platform.local_branches()
        && let Ok(remote) = platform.remote_branches()
    {
        for mut reference in local.chain(remote).flatten() {
            // `refs/remotes/<远端>/HEAD` 这类符号引用不是分支：Desktop getBranches 与 GitLens 提交图都不列
            // （较新的 git fetch 会按 followRemoteHEAD 建出它来）
            if matches!(reference.target(), gix::refs::TargetRef::Symbolic(_)) {
                continue;
            }
            let name = reference.name().shorten().to_string();
            let full = reference.name().as_bstr().to_string();
            // 没有已配置的远端匹配时退回第一段（远端已删、只剩跟踪引用），与 branch::list 一致
            let remote = full.strip_prefix("refs/remotes/").map(|rest| {
                crate::branch::split_remote_branch_name(rest, &remote_names)
                    .map_or_else(|| rest.split_once('/').map_or(rest, |(owner, _)| owner), |(owner, _)| owner)
                    .to_string()
            });
            if let Ok(id) = reference.peel_to_id() {
                branches.entry(id.to_string()).or_default().push((name, GraphBranch { reference: full, remote }));
            }
        }
    }

    let head = match repo.head() {
        Ok(head) => match head.kind {
            gix::head::Kind::Symbolic(reference) => match reference.target {
                gix::refs::Target::Object(id) => Some((id.to_string(), reference.name.shorten().to_string())),
                gix::refs::Target::Symbolic(_) => None,
            },
            gix::head::Kind::Detached { peeled, target } => {
                let id = peeled.unwrap_or(target).to_string();
                Some((id, "HEAD".into()))
            }
            gix::head::Kind::Unborn(_) => None,
        },
        Err(_) => None,
    };
    Decorations { branches, head }
}

/// 一个贮藏：`stash@{index}` 的提交、它的基提交（第一个父提交）和提交时间。
struct Stash {
    index: usize,
    id: gix::ObjectId,
    base: gix::ObjectId,
    time: i64,
}

/// `refs/stash` 的 reflog，从新到旧，第 n 条就是 `stash@{n}`（同 `git log -g refs/stash`）。
/// 没有 reflog（`core.logAllRefUpdates=false`）时只有 `refs/stash` 本身这一条。
/// 不是提交、没有父提交的条目不是 `git stash` 产生的贮藏，跳过。
fn stashes(repo: &gix::Repository) -> Vec<Stash> {
    let Ok(Some(reference)) = repo.try_find_reference("refs/stash") else { return Vec::new() };
    let mut ids = Vec::new();
    let mut log = reference.log_iter();
    if let Ok(Some(entries)) = log.rev() {
        ids.extend(entries.flatten().map(|entry| entry.new_oid).filter(|id| !id.is_null()));
    }
    if ids.is_empty()
        && let Some(id) = reference.target().try_id()
    {
        ids.push(id.to_owned());
    }
    ids.into_iter()
        .enumerate()
        .filter_map(|(index, id)| {
            let commit = repo.find_object(id).ok()?.try_into_commit().ok()?;
            let base = commit.parent_ids().next()?.detach();
            let time = commit.time().ok()?.seconds;
            Some(Stash { index, id, base, time })
        })
        .collect()
}

/// 排队的提交从哪里取父提交：在 commit-graph 里的只记位置，不在的解码对象时顺手留下父提交。
enum Source {
    Graph(gix::commitgraph::Position),
    Parents(Vec<gix::ObjectId>),
}

/// 读提交的排序日期与父提交。两者优先取 commit-graph（git `parse_commit_in_graph` 同样不读对象）：
/// 几百个标签做起点时，gix 的 `rev_walk` 会把每个起点从对象库解码一遍来取时间，Desktop 仓库
/// 690 个起点要 3 ms。浅克隆边界上的提交没有父提交（shallow 文件），和 `git log` 一样。
struct Reader<'repo> {
    repo: &'repo gix::Repository,
    graph: Option<gix::commitgraph::Graph>,
    shallow: std::collections::HashSet<gix::ObjectId>,
}

impl<'repo> Reader<'repo> {
    fn new(repo: &'repo gix::Repository, shallow: &[gix::ObjectId]) -> Self {
        Self { repo, graph: repo.commit_graph_if_enabled().ok().flatten(), shallow: shallow.iter().copied().collect() }
    }

    fn describe(&self, id: gix::ObjectId) -> Result<(i64, Source), String> {
        if let Some(graph) = &self.graph
            && let Some(pos) = graph.lookup(id)
        {
            return Ok((graph.commit_at(pos).committer_timestamp() as i64, Source::Graph(pos)));
        }
        let commit = self.repo.find_commit(id).map_err(|e| format!("读提交对象失败: {e}"))?;
        let time = commit.time().map_err(|e| format!("解析提交时间失败: {e}"))?.seconds;
        Ok((time, Source::Parents(commit.parent_ids().map(|id| id.detach()).collect())))
    }

    fn parents(&self, id: gix::ObjectId, source: Source) -> Result<Vec<gix::ObjectId>, String> {
        if self.shallow.contains(&id) {
            return Ok(Vec::new());
        }
        match source {
            Source::Parents(parents) => Ok(parents),
            Source::Graph(pos) => {
                let graph = self.graph.as_ref().expect("只有打开了 commit-graph 才有图里的位置");
                let mut parents = Vec::new();
                for parent in graph.commit_at(pos).iter_parents() {
                    let parent = parent.map_err(|e| format!("读取 commit-graph 失败: {e}"))?;
                    parents.push(graph.id_at(parent).to_owned());
                }
                Ok(parents)
            }
        }
    }
}

/// 优先队列里的一个提交：按提交时间取最新，时间相同按进队先后（git prio_queue.c 的
/// `insertion_ctr`，`compare_commits_by_commit_date` 相等时序号小的先出）。`BinaryHeap` 取最大值，
/// 所以序号反向比较。
struct Queued {
    time: i64,
    seq: u64,
    node: u32,
}

impl PartialEq for Queued {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == std::cmp::Ordering::Equal
    }
}
impl Eq for Queued {}
impl PartialOrd for Queued {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Queued {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.time.cmp(&other.time).then_with(|| other.seq.cmp(&self.seq))
    }
}

/// 按 `git rev-list --date-order` 排好的整条序列：起点能走到的全部提交。
///
/// 紧凑存放：sha、提交时间，以及按偏移切出的父提交（值是父提交在 `ids` 里的下标，父提交总在子提交之后）。
/// 每个提交 32 字节加每个父提交 4 字节。
pub(crate) struct Sorted {
    ids: Vec<gix::ObjectId>,
    times: Vec<i64>,
    /// 第 i 个提交的父提交是 `parents[offsets[i]..offsets[i + 1]]`
    offsets: Vec<u32>,
    parents: Vec<u32>,
}

impl Sorted {
    fn len(&self) -> usize {
        self.ids.len()
    }

    fn parents(&self, at: usize) -> impl Iterator<Item = gix::ObjectId> + '_ {
        self.parents[self.offsets[at] as usize..self.offsets[at + 1] as usize]
            .iter()
            .map(|&parent| self.ids[parent as usize])
    }
}

/// git `--date-order`：commit.c `sort_in_topological_order(REV_SORT_BY_COMMIT_DATE)` 的一比一移植。
///
///   1. 把起点能走到的集合整个走完（revision.c `limit_list`）。起点先编号，它们的相对顺序决定
///      同一时间谁先进队；`prepare_revision_walk` 对起点去重后按提交时间稳定降序排（`commit_list_insert_by_date`
///      再 `commit_list_sort_by_date`），所以这里对起点做稳定排序。
///   2. 入度：集合里每个提交记 1，再为它的每个父提交加 1。父提交重复（两个父提交相同）时加两次、后面也减两次，
///      和 git 一样不去重。
///   3. 入度仍为 1（没有子提交）的起点按第 1 步的顺序进优先队列。
///   4. 每弹出一个提交就输出它，并给每个父提交的入度减 1，减到 1 的进队（所有子提交都已输出，
///      所以输出一定是拓扑序）；入度已是 0 的父提交（不在集合里）跳过。队列按提交时间取最新，
///      时间相同按进队先后——这正是和默认顺序的差别：默认顺序让父提交和子提交一起竞争，
///      同一秒或时钟倒退时父提交会先出来。
///
/// git 有世代号（commit-graph）时改走 revision.c 的增量 topo walk（`init_topo_walk`），只把入度算到
/// 需要的世代；两种实现输出相同（git t6012），这里一律走完整版，结果整条缓存，之后翻页只取切片。
/// 浅克隆边界上的提交没有父提交，泳道在边界收掉。
fn date_order(repo: &gix::Repository, tips: &[gix::ObjectId], shallow: &[gix::ObjectId]) -> Result<Sorted, String> {
    let reader = Reader::new(repo, shallow);

    // 1. 走完可达集合。起点先编号，其余提交按发现顺序编号；父提交按编号顺序读，所以偏移顺手就排好了
    let mut index: HashMap<gix::ObjectId, u32> = HashMap::with_capacity(tips.len());
    let mut ids: Vec<gix::ObjectId> = Vec::new();
    let mut times: Vec<i64> = Vec::new();
    let mut sources: Vec<Option<Source>> = Vec::new();
    for &id in tips {
        if index.contains_key(&id) {
            continue;
        }
        index.insert(id, ids.len() as u32);
        let (time, source) = reader.describe(id)?;
        ids.push(id);
        times.push(time);
        sources.push(Some(source));
    }
    let starts = ids.len();
    let mut offsets: Vec<u32> = vec![0];
    let mut parents: Vec<u32> = Vec::new();
    let mut next = 0;
    while next < ids.len() {
        let source = sources[next].take().expect("每个提交只读一次父提交");
        for parent in reader.parents(ids[next], source)? {
            let at = match index.get(&parent) {
                Some(&at) => at,
                None => {
                    let at = ids.len() as u32;
                    index.insert(parent, at);
                    let (time, source) = reader.describe(parent)?;
                    ids.push(parent);
                    times.push(time);
                    sources.push(Some(source));
                    at
                }
            };
            parents.push(at);
        }
        offsets.push(parents.len() as u32);
        next += 1;
    }
    drop(sources);
    drop(index);
    let total = ids.len();

    // 2. 入度
    let mut indegree: Vec<u32> = vec![1; total];
    for &parent in &parents {
        indegree[parent as usize] += 1;
    }

    // 3. 起点稳定按时间降序，没有子提交的进队
    let mut heap: std::collections::BinaryHeap<Queued> = std::collections::BinaryHeap::new();
    let mut seq = 0u64;
    let mut sorted_starts: Vec<u32> = (0..starts as u32).collect();
    sorted_starts.sort_by_key(|&node| std::cmp::Reverse(times[node as usize]));
    for node in sorted_starts {
        if indegree[node as usize] == 1 {
            heap.push(Queued { time: times[node as usize], seq, node });
            seq += 1;
        }
    }

    // 4. 弹出即输出；父提交减到 1 时进队
    let mut order: Vec<u32> = Vec::with_capacity(total);
    while let Some(Queued { node, .. }) = heap.pop() {
        let at = node as usize;
        for &parent in &parents[offsets[at] as usize..offsets[at + 1] as usize] {
            let degree = &mut indegree[parent as usize];
            if *degree == 0 {
                continue;
            }
            *degree -= 1;
            if *degree == 1 {
                heap.push(Queued { time: times[parent as usize], seq, node: parent });
                seq += 1;
            }
        }
        indegree[at] = 0;
        order.push(node);
    }

    // 按序重排，父提交改成序列里的下标
    let mut rank: Vec<u32> = vec![0; total];
    for (position, &node) in order.iter().enumerate() {
        rank[node as usize] = position as u32;
    }
    let mut sorted = Sorted {
        ids: Vec::with_capacity(order.len()),
        times: Vec::with_capacity(order.len()),
        offsets: Vec::with_capacity(order.len() + 1),
        parents: Vec::with_capacity(parents.len()),
    };
    sorted.offsets.push(0);
    for &node in &order {
        let at = node as usize;
        sorted.ids.push(ids[at]);
        sorted.times.push(times[at]);
        sorted.parents.extend(
            parents[offsets[at] as usize..offsets[at + 1] as usize].iter().map(|&parent| rank[parent as usize]),
        );
        sorted.offsets.push(sorted.parents.len() as u32);
    }
    Ok(sorted)
}

/// 排好的整条序列按仓库缓存。
///
/// `--date-order` 只能在整条可达集合上算（最后一个子提交出现之前父提交不能出），所以第一页就排完
/// 整条，之后每页从缓存里取切片。键是起点（全部引用 + 贮藏基提交，去重后按顺序）与浅克隆边界：
/// 序列只取决于它们和不可变的对象，任一起点变了（提交、fetch、切分支、贮藏、删标签）键就对不上，
/// 同一仓库的旧条目被换掉；起点没变时 HEAD 换了也不用重排。
///
/// 内存：每个提交 32 字节（sha 20、时间 8、偏移 4）加每个父提交 4 字节，Homebrew 53 371 个提交约 2 MB，
/// 键里的起点每个 20 字节。最多留 [`MAX`] 个仓库，闲置 [`TTL`] 后丢弃，同一仓库只留最新的一条。
mod order {
    use super::Sorted;
    use std::sync::Arc;
    #[cfg(not(test))]
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    pub(super) const MAX: usize = 4;
    pub(super) const TTL: Duration = Duration::from_secs(10 * 60);

    #[derive(PartialEq, Eq)]
    pub(super) struct Key {
        pub(super) git_dir: std::path::PathBuf,
        pub(super) tips: Vec<gix::ObjectId>,
        pub(super) shallow: Vec<gix::ObjectId>,
    }

    struct Entry {
        key: Key,
        /// 最近一次用到的时间
        at: Instant,
        sorted: Arc<Sorted>,
    }

    #[cfg(not(test))]
    static STORE: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

    #[cfg(not(test))]
    fn with_store<T>(f: impl FnOnce(&mut Vec<Entry>) -> T) -> T {
        f(&mut STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    // 测试并行跑，各线程各用一份，互不挤掉对方的条目。
    #[cfg(test)]
    thread_local! {
        static STORE: std::cell::RefCell<Vec<Entry>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    #[cfg(test)]
    fn with_store<T>(f: impl FnOnce(&mut Vec<Entry>) -> T) -> T {
        STORE.with_borrow_mut(f)
    }

    /// 起点完全相同的序列；过期的当作没有
    pub(super) fn get(key: &Key) -> Option<Arc<Sorted>> {
        with_store(|store| {
            let now = Instant::now();
            store.retain(|entry| now.duration_since(entry.at) < TTL);
            let entry = store.iter_mut().find(|entry| entry.key == *key)?;
            entry.at = now;
            Some(entry.sorted.clone())
        })
    }

    pub(super) fn put(key: Key, sorted: Arc<Sorted>) {
        with_store(|store| {
            let now = Instant::now();
            store.retain(|entry| now.duration_since(entry.at) < TTL && entry.key.git_dir != key.git_dir);
            if store.len() >= MAX {
                let oldest = store.iter().enumerate().min_by_key(|(_, entry)| entry.at).map(|(at, _)| at);
                if let Some(at) = oldest {
                    store.remove(at);
                }
            }
            store.push(Entry { key, at: now, sorted });
        });
    }

    /// 丢掉这个仓库的序列
    pub(super) fn forget(git_dir: &std::path::Path) {
        with_store(|store| store.retain(|entry| entry.key.git_dir != git_dir));
    }

    #[cfg(test)]
    pub(super) fn len() -> usize {
        with_store(|store| store.len())
    }

    #[cfg(test)]
    pub(super) fn cached(git_dir: &std::path::Path) -> Option<Arc<Sorted>> {
        with_store(|store| store.iter().find(|entry| entry.key.git_dir == git_dir).map(|entry| entry.sorted.clone()))
    }
}

/// 丢掉这个仓库缓存的序列，下一页重新排。基准用它测第一页的冷开销。
#[allow(dead_code)] // The benchmark times a cold first page; the app relies on the tip-set key alone.
pub fn forget(root: &Path) {
    if let Ok(repo) = gix::open(root) {
        order::forget(repo.git_dir());
    }
}

/// 遍历出来、还没读提交信息的一行。
struct Entry {
    id: gix::ObjectId,
    parents: Vec<gix::ObjectId>,
    stash: Option<usize>,
    on_head: bool,
}

/// 读一页提交并算好泳道，顺带把指向它们的分支/标签名挂上。
///
/// 起点是 `git log --all` 里的这几类引用：HEAD、本地分支、远端跟踪分支、标签（引用索引缓存，
/// 见 `history::graph_index`），外加每个贮藏的基提交（贮藏所在分支删掉后只有贮藏还指着它）。
/// 顺序与 GitLens 提交图的 `git log --all --date-order` 逐条相同（[`date_order`]）：按提交时间，
/// 但父提交一定等所有子提交出完才出，同一秒的一串提交和时钟倒退的历史也保持拓扑序；gix 默认的
/// 广度优先和 `git log` 的默认顺序都做不到，泳道会等一个已经画过的提交，一直悬着收不回来。
///
/// 贮藏照 GitLens graph.stashRows：`refs/stash` reflog 的每一条单独成行，只连第一个父提交
/// （基提交）；索引、未跟踪文件这两个内部父提交不遍历、不成行。贮藏行按提交时间插进序列，
/// 并保证排在基提交之前。
///
/// 翻页仍是「跳过前 `skip` 行」：序列整条缓存（[`order`]），被跳过的部分只走缓存里的 sha 和父提交，不读提交信息。
pub fn graph(root: &Path, limit: usize, skip: usize, cursor: Option<GraphCursor>) -> Result<GraphPage, String> {
    let repo = gix::open(root).map_err(|e| format!("打开仓库失败: {e}"))?;
    let mut cursor = cursor.unwrap_or_default();

    let (tags_by_commit, ref_tips) = crate::history::graph_index(&repo)?;
    let stashes = stashes(&repo);
    let head = repo.head_id().ok().map(|id| id.detach());
    // 引用按 `git log --all` 的顺序在前，贮藏的基提交在后（GitLens 经 --stdin 追加贮藏）；
    // 重复的起点只留第一次（prepare_revision_walk 的 SEEN）
    let mut seen: std::collections::HashSet<gix::ObjectId> = std::collections::HashSet::new();
    let tips: Vec<gix::ObjectId> =
        ref_tips.iter().copied().chain(stashes.iter().map(|stash| stash.base)).filter(|id| seen.insert(*id)).collect();
    if tips.is_empty() {
        // 空仓库（还没有任何提交）不是错误
        return Ok(GraphPage { rows: Vec::new(), cursor, done: true });
    }
    let shallow: Vec<gix::ObjectId> = repo
        .shallow_commits()
        .map_err(|e| format!("读取浅克隆边界失败: {e}"))?
        .map(|commits| commits.iter().copied().collect())
        .unwrap_or_default();
    let key = order::Key { git_dir: repo.git_dir().to_path_buf(), tips, shallow };
    let sorted = match order::get(&key) {
        Some(sorted) => sorted,
        None => {
            let sorted = std::sync::Arc::new(date_order(&repo, &key.tips, &key.shallow)?);
            order::put(key, sorted.clone());
            sorted
        }
    };

    // 贮藏按时间从新到旧，同一秒的按 stash@{n} 从小到大
    let mut pending: Vec<&Stash> = stashes.iter().collect();
    pending.sort_by(|a, b| b.time.cmp(&a.time).then(a.index.cmp(&b.index)));
    let mut pending: std::collections::VecDeque<&Stash> = pending.into();
    let stash_ids: std::collections::HashSet<gix::ObjectId> = stashes.iter().map(|stash| stash.id).collect();

    // HEAD 能走到的提交。子提交总在父提交之前出现，所以轮到一个提交时它的标记已经定了
    let mut reachable: std::collections::HashSet<gix::ObjectId> = head.into_iter().collect();
    // 只排到这一页的末尾；被跳过的行只占一个 sha 和父提交列表
    let end = skip + limit;
    let mut order: Vec<Entry> = Vec::with_capacity(end.min(4096));
    let stash_entry =
        |stash: &Stash| Entry { id: stash.id, parents: vec![stash.base], stash: Some(stash.index), on_head: false };

    let mut at = 0;
    while order.len() < end && at < sorted.len() {
        let (id, time) = (sorted.ids[at], sorted.times[at]);
        let parents: Vec<gix::ObjectId> = sorted.parents(at).collect();
        at += 1;
        // 有引用直接指着贮藏提交时它也会被遍历到；贮藏只按贮藏行出一次
        if stash_ids.contains(&id) {
            continue;
        }
        while let Some(stash) = pending.front().copied().filter(|stash| stash.time >= time) {
            pending.pop_front();
            order.push(stash_entry(stash));
        }
        while let Some(at) = pending.iter().position(|stash| stash.base == id) {
            if let Some(stash) = pending.remove(at) {
                order.push(stash_entry(stash));
            }
        }
        let on_head = reachable.remove(&id);
        if on_head {
            reachable.extend(parents.iter().copied());
        }
        order.push(Entry { id, parents, stash: None, on_head });
    }
    // 基提交不在序列里（浅克隆边界之外）的贮藏排在最后
    order.extend(pending.into_iter().map(stash_entry));
    let entries: Vec<Entry> = order.into_iter().skip(skip).take(limit).collect();

    let mut commits = Vec::with_capacity(entries.len());
    let mut kinds = Vec::with_capacity(entries.len());
    for entry in entries {
        let commit = repo.find_object(entry.id).map_err(|e| format!("读提交对象失败: {e}"))?.into_commit();
        let msg = commit.message().map_err(|e| format!("解析提交信息失败: {e}"))?;
        let author = commit.author().map_err(|e| format!("解析作者失败: {e}"))?;
        let sha = entry.id.to_string();
        commits.push(CommitInfo {
            short_sha: sha[..7.min(sha.len())].to_string(),
            tags: tags_by_commit.get(&sha).cloned().unwrap_or_default(),
            sha,
            summary: msg.summary().to_string(),
            body: msg.body.map(|b| b.to_string()).unwrap_or_default(),
            author_name: author.name.to_string(),
            author_email: author.email.to_string(),
            time: author.seconds(),
            parent_count: entry.parents.len() as u32,
            parent_sh_as: entry.parents.iter().map(|id| id.to_string()).collect(),
        });
        kinds.push((entry.stash, entry.on_head));
    }
    let done = commits.len() < limit;

    let decorations = decorations(&repo);
    let mut rows = continue_lanes(&mut cursor, commits);
    for (row, (stash, on_head)) in rows.iter_mut().zip(kinds) {
        row.stash = stash;
        row.on_head = on_head;
        let mut branches = decorations.branches.get(&row.commit.sha).cloned().unwrap_or_default();
        let mut refs: Vec<String> = Vec::new();
        if let Some((sha, name)) = &decorations.head
            && *sha == row.commit.sha
        {
            // HEAD 所在的本地分支排最前；分离 HEAD 只在 `refs` 里标 `HEAD`，不是分支
            if let Some(at) = branches.iter().position(|(short, branch)| short == name && branch.remote.is_none()) {
                let current = branches.remove(at);
                refs.push(current.0);
                row.branches.push(current.1);
            } else {
                refs.push(name.clone());
            }
            row.head = Some(name.clone());
        }
        for (short, branch) in branches {
            refs.push(short);
            row.branches.push(branch);
        }
        refs.extend(row.commit.tags.iter().cloned());
        row.refs = refs;
    }
    Ok(GraphPage { rows, cursor, done })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// 一次算完整段历史
    fn lanes(commits: Vec<CommitInfo>) -> Vec<GraphRow> {
        continue_lanes(&mut GraphCursor::default(), commits)
    }

    fn commit(sha: &str, parents: &[&str]) -> CommitInfo {
        CommitInfo {
            sha: sha.into(),
            short_sha: sha.into(),
            summary: sha.into(),
            body: String::new(),
            author_name: "T".into(),
            author_email: "t@e.com".into(),
            time: 0,
            tags: Vec::new(),
            parent_count: parents.len() as u32,
            parent_sh_as: parents.iter().map(|p| p.to_string()).collect(),
        }
    }

    fn shas(lanes: &[Option<String>]) -> Vec<&str> {
        lanes.iter().map(|l| l.as_deref().unwrap_or("")).collect()
    }

    #[test]
    fn 线性历史只占一条泳道() {
        let rows = lanes(vec![commit("c", &["b"]), commit("b", &["a"]), commit("a", &[])]);
        assert!(rows.iter().all(|r| r.lane == 0), "线性历史不该分叉");
        assert!(rows.iter().all(|r| r.stream == 0), "同一条线同一个色流");
        // 最后一个提交没有父提交，泳道应该收干净
        assert!(rows.last().unwrap().lanes.is_empty());
    }

    #[test]
    fn 合并提交会多开一条泳道再收回来() {
        //   m        合并
        //  / \
        // f   b      两条线
        //  \ /
        //   a
        let rows = lanes(vec![commit("m", &["b", "f"]), commit("f", &["a"]), commit("b", &["a"]), commit("a", &[])]);

        assert_eq!(rows[0].lane, 0, "合并提交在主泳道");
        assert_eq!(shas(&rows[0].lanes), ["b", "f"], "合并之后有两条线并行");
        assert_eq!(rows[0].streams, [0, 1]);
        assert_eq!((rows[1].lane, rows[1].stream), (1, 1), "f 在第二条泳道、第二个色流");
        assert_eq!(shas(&rows[1].lanes), ["b", "a"], "f 的泳道接着等 a");
        assert_eq!(shas(&rows[2].lanes), ["a", "a"], "两条线都等着 a");
        // 两条线最终都汇到 a，a 之后图收干净
        assert_eq!(rows[3].commit.sha, "a");
        assert_eq!((rows[3].lane, rows[3].stream), (0, 0), "汇合时左边的色流存活");
        assert!(rows[3].lanes.is_empty(), "汇合后不该留空泳道");
    }

    #[test]
    fn 多个子提交指向同一个父提交时泳道会合并() {
        let rows = lanes(vec![commit("x", &["a"]), commit("y", &["a"]), commit("a", &[])]);
        // x 和 y 各占一条泳道，到 a 汇成一条
        assert_eq!(rows[0].lane, 0);
        assert_eq!(rows[1].lane, 1);
        assert_eq!(rows[2].lane, 0, "汇合到第一条泳道");
        assert!(rows[2].lanes.is_empty());
    }

    #[test]
    fn 三条泳道汇成一条时只留最左边的色流() {
        // m 的三个父提交各自经过一个提交后都汇到 a
        let rows = lanes(vec![
            commit("m", &["p", "q", "r"]),
            commit("p", &["a"]),
            commit("q", &["a"]),
            commit("r", &["a"]),
            commit("a", &["z"]),
        ]);
        assert_eq!(rows[0].streams, [0, 1, 2], "章鱼合并一次开两条泳道");
        assert_eq!(shas(&rows[3].lanes), ["a", "a", "a"]);
        let a = &rows[4];
        assert_eq!((a.lane, a.stream), (0, 0));
        assert_eq!(shas(&a.lanes), ["z"]);
        assert_eq!(a.streams, [0], "存活的是最左泳道的色流");
    }

    #[test]
    fn 泳道左移时色流跟着走() {
        // m -> a, y ; a -> b, z ; y -> b ; b 行里 y 的泳道汇入，z 从第 3 列挪到第 2 列
        let rows = lanes(vec![
            commit("m", &["a", "y"]),
            commit("a", &["b", "z"]),
            commit("y", &["b"]),
            commit("b", &["c"]),
            commit("z", &["c"]),
        ]);
        assert_eq!(shas(&rows[1].lanes), ["b", "y", "z"]);
        assert_eq!(rows[1].streams, [0, 1, 2]);
        assert_eq!(shas(&rows[2].lanes), ["b", "b", "z"]);
        let b = &rows[3];
        assert_eq!(shas(&b.lanes), ["c", "z"], "汇入的泳道收掉，z 左移");
        assert_eq!(b.streams, [0, 2], "z 左移后仍是第 3 个色流");
        assert_eq!((rows[4].lane, rows[4].stream), (1, 2));
    }

    #[test]
    fn 第二个父提交已在等待中就不再开泳道() {
        // n 的第一个父提交 x 已经占着第二条泳道；m 再合并 x 时直接连过去
        let rows = lanes(vec![
            commit("t", &["n", "x"]),
            commit("n", &["m"]),
            commit("m", &["a", "x"]),
            commit("x", &["a"]),
            commit("a", &[]),
        ]);
        assert_eq!(shas(&rows[0].lanes), ["n", "x"]);
        let m = &rows[2];
        assert_eq!(shas(&m.lanes), ["a", "x"], "x 已经有泳道，不再重复");
        assert_eq!(m.lanes.iter().filter(|l| l.as_deref() == Some("x")).count(), 1);
        assert_eq!(rows[3].streams, [0, 1]);
        assert!(rows[4].lanes.is_empty());
    }

    #[test]
    fn 根提交结束自己的泳道() {
        // 两个根（例如 subtree 合并进来的历史）
        let rows = lanes(vec![commit("m", &["a", "r"]), commit("r", &[]), commit("a", &[])]);
        assert_eq!(shas(&rows[0].lanes), ["a", "r"]);
        assert_eq!((rows[1].lane, rows[1].stream), (1, 1));
        assert_eq!(shas(&rows[1].lanes), ["a"], "根提交 r 的泳道收掉");
        assert_eq!((rows[2].lane, rows[2].stream), (0, 0));
        assert!(rows[2].lanes.is_empty());
    }

    /// 确定性地生成一段合并密集的历史：主线 `m0..mN`，每 4 个主线提交合并一条
    /// 三个提交的分支，分支从 6 个主线提交之前分出去，所以总有两三条分支并行。
    /// 列表顺序保证子在父前（分支提交紧跟在合并它的主线提交之后）。
    fn busy_history(main: usize) -> Vec<CommitInfo> {
        let m = |i: usize| format!("m{i:03}");
        let mut commits = Vec::new();
        for i in 0..main {
            let branch = i % 4 == 0 && i + 6 < main;
            let mut parents = if i + 1 < main { vec![m(i + 1)] } else { Vec::new() };
            if branch {
                parents.push(format!("f{i:03}-0"));
            }
            let refs: Vec<&str> = parents.iter().map(String::as_str).collect();
            commits.push(commit(&m(i), &refs));
            if branch {
                for k in 0..3 {
                    let parent = if k < 2 { format!("f{i:03}-{}", k + 1) } else { m(i + 6) };
                    commits.push(commit(&format!("f{i:03}-{k}"), &[parent.as_str()]));
                }
            }
        }
        commits
    }

    #[test]
    fn 分批翻页与一次算完逐字节相同() {
        let history = busy_history(40);
        let rows = lanes(history.clone());
        let widest = rows.iter().map(|row| row.lanes.len()).max().unwrap();
        let streams = rows.iter().map(|row| row.stream).max().unwrap();
        assert!(widest >= 3 && streams >= 3, "夹具要真的分出多条泳道和色流：{widest} 条泳道、{streams} 个色流");
        let whole = serde_json::to_string(&rows).unwrap();

        let total = history.len();
        for batch in [1usize, 2, 3, 7, 13, total - 1, total, total + 1] {
            let mut cursor = GraphCursor::default();
            let mut rows = Vec::new();
            for chunk in history.chunks(batch) {
                rows.extend(continue_lanes(&mut cursor, chunk.to_vec()));
            }
            assert_eq!(serde_json::to_string(&rows).unwrap(), whole, "每批 {batch} 条");
            assert!(cursor.lanes.is_empty(), "整段历史画完不该剩泳道");
        }
    }

    #[test]
    fn 跨页边界色流不变() {
        let history = busy_history(40);
        let whole = lanes(history.clone());
        let mut cursor = GraphCursor::default();
        let first = continue_lanes(&mut cursor, history[..17].to_vec());
        assert_eq!(cursor.streams, first.last().unwrap().streams, "游标就是上一页末尾的状态");
        let second = continue_lanes(&mut cursor, history[17..].to_vec());
        assert_eq!(second[0].stream, whole[17].stream);
        assert_eq!(second[0].streams, whole[17].streams);
        // 跨过页边界的泳道用的还是第一页分配的色流
        assert!(first.last().unwrap().streams.iter().any(|s| second[0].streams.contains(s)));
    }

    #[test]
    fn 游标序列化为驼峰字段() {
        let cursor = GraphCursor { lanes: vec!["a".into()], streams: vec![4], next_stream: 5 };
        let json = serde_json::to_string(&cursor).unwrap();
        assert_eq!(json, r#"{"lanes":["a"],"streams":[4],"nextStream":5}"#);
        assert_eq!(serde_json::from_str::<GraphCursor>(&json).unwrap(), cursor);
    }

    // ── 真实仓库 ────────────────────────────────────────────────

    /// 测试里故意直接调 git，不走 crate::git 的封装。时间固定，排序才可预期。
    fn git(r: &Path, date: &str, args: &[&str]) -> String {
        let o = Command::new("git")
            .arg("-C")
            .arg(r)
            .args(args)
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    /// main 上一个提交 b，feature 上 g、f，main 上 a，再把 feature 合进来：
    ///
    ///   m (main, HEAD)
    ///   |\
    ///   a f (feature)
    ///   | g
    ///   |/
    ///   b (v1)
    fn merged_repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, "1000000001 +0000", &["init", "-q", "-b", "main", "."]);
        git(&r, "1000000001 +0000", &["config", "user.email", "t@t.t"]);
        git(&r, "1000000001 +0000", &["config", "user.name", "t"]);
        git(&r, "1000000001 +0000", &["commit", "-q", "--allow-empty", "-m", "b"]);
        git(&r, "1000000001 +0000", &["tag", "v1"]);
        git(&r, "1000000002 +0000", &["checkout", "-q", "-b", "feature"]);
        git(&r, "1000000002 +0000", &["commit", "-q", "--allow-empty", "-m", "g"]);
        git(&r, "1000000003 +0000", &["commit", "-q", "--allow-empty", "-m", "f"]);
        git(&r, "1000000004 +0000", &["checkout", "-q", "main"]);
        git(&r, "1000000004 +0000", &["commit", "-q", "--allow-empty", "-m", "a"]);
        git(&r, "1000000005 +0000", &["merge", "-q", "--no-ff", "-m", "m", "feature"]);
        (d, r)
    }

    #[test]
    fn 真实仓库按父在子后排序并挂上装饰() {
        let (_d, r) = merged_repo();
        let page = graph(&r, 100, 0, None).unwrap();
        assert!(page.done);
        let order: Vec<&str> = page.rows.iter().map(|row| row.commit.summary.as_str()).collect();
        assert_eq!(order, ["m", "a", "f", "g", "b"], "广度优先会把 b 排到 g 前面，泳道就悬着收不回");
        // 每个父提交都在它所有子提交之后
        for (i, row) in page.rows.iter().enumerate() {
            for parent in &row.commit.parent_sh_as {
                let at = page.rows.iter().position(|r| r.commit.sha == *parent).unwrap();
                assert!(at > i, "{} 的父提交排在了前面", row.commit.summary);
            }
        }
        let streams: Vec<u32> = page.rows.iter().map(|row| row.stream).collect();
        assert_eq!(streams, [0, 0, 1, 1, 0], "feature 两个提交一个色流，main 另一个");
        assert!(page.rows.last().unwrap().lanes.is_empty(), "汇合后泳道收干净");
        assert!(page.cursor.lanes.is_empty());

        assert_eq!(page.rows[0].refs, ["main"]);
        assert_eq!(page.rows[0].head.as_deref(), Some("main"));
        assert_eq!(page.rows[2].refs, ["feature"]);
        assert_eq!(page.rows[2].head, None);
        assert_eq!(page.rows[4].refs, ["v1"], "标签来自缓存的引用索引");
    }

    #[test]
    fn 真实仓库分页接着上一页的泳道() {
        let (_d, r) = merged_repo();
        let whole = graph(&r, 100, 0, None).unwrap();
        let mut rows = Vec::new();
        let mut cursor = None;
        let mut skip = 0;
        loop {
            let page = graph(&r, 2, skip, cursor).unwrap();
            skip += page.rows.len();
            rows.extend(page.rows);
            cursor = Some(page.cursor);
            if page.done {
                break;
            }
        }
        assert_eq!(skip, 5);
        assert_eq!(serde_json::to_string(&rows).unwrap(), serde_json::to_string(&whole.rows).unwrap());
    }

    #[test]
    fn 分离头指针标为_head() {
        let (_d, r) = merged_repo();
        let sha = git(&r, "1000000006 +0000", &["rev-parse", "feature"]);
        git(&r, "1000000006 +0000", &["checkout", "-q", &sha]);
        let page = graph(&r, 100, 0, None).unwrap();
        let order: Vec<&str> = page.rows.iter().map(|row| row.commit.summary.as_str()).collect();
        assert_eq!(order, ["m", "a", "f", "g", "b"], "main 不在 HEAD 历史上也照样遍历");
        let on_head: Vec<bool> = page.rows.iter().map(|row| row.on_head).collect();
        assert_eq!(on_head, [false, false, true, true, true], "只有 HEAD 走得到的提交能按 HEAD 历史改写");
        assert_eq!(page.rows[0].refs, ["main"]);
        assert_eq!(page.rows[0].head, None);
        assert_eq!(page.rows[2].refs, ["HEAD", "feature"]);
        assert_eq!(page.rows[2].head.as_deref(), Some("HEAD"));
        assert_eq!(
            page.rows[2].branches,
            [GraphBranch { reference: "refs/heads/feature".into(), remote: None }],
            "分离的 HEAD 不是分支"
        );
    }

    /// GitLens graph.slashRemote：远端名本身带 `/` 时，跟踪分支归属整个远端而不是第一段；
    /// 与跟踪分支同短名、同提交的本地分支仍是本地分支。
    #[test]
    fn 带斜杠的远端与同名本地分支分开标注() {
        let (_d, r) = merged_repo();
        git(&r, "1000000006 +0000", &["remote", "add", "team/fork", "https://example.invalid/fork.git"]);
        git(&r, "1000000006 +0000", &["update-ref", "refs/remotes/team/fork/work", "HEAD"]);
        git(&r, "1000000006 +0000", &["checkout", "-q", "-b", "team/fork/work"]);
        let page = graph(&r, 100, 0, None).unwrap();
        let row = &page.rows[0];
        assert_eq!(row.head.as_deref(), Some("team/fork/work"));
        assert_eq!(row.refs, ["team/fork/work", "main", "team/fork/work"], "扁平短名分不出本地与远端");
        let branch = |reference: &str, remote: Option<&str>| GraphBranch {
            reference: reference.into(),
            remote: remote.map(Into::into),
        };
        assert_eq!(
            row.branches,
            [
                branch("refs/heads/team/fork/work", None),
                branch("refs/heads/main", None),
                branch("refs/remotes/team/fork/work", Some("team/fork")),
            ],
            "HEAD 所在的本地分支在前，远端按最长的已配置远端归属"
        );
    }

    fn summaries(rows: &[GraphRow]) -> Vec<&str> {
        rows.iter().map(|row| row.commit.summary.as_str()).collect()
    }

    /// 每个父提交都排在它所有子提交之后，且整页画完泳道收干净
    fn assert_topological(rows: &[GraphRow]) {
        for (i, row) in rows.iter().enumerate() {
            for parent in &row.commit.parent_sh_as {
                let at = rows.iter().position(|r| r.commit.sha == *parent);
                assert!(at.is_some_and(|at| at > i), "{} 的父提交 {parent} 不在它之后", row.commit.summary);
            }
        }
        assert!(rows.last().unwrap().lanes.is_empty(), "画完不该剩泳道");
    }

    /// merged_repo 之外再挂上与 HEAD 不相连的引用：
    ///   - 孤立分支 `orphan`（o1 ← o2），
    ///   - 只有远端跟踪引用指着的 r（`refs/remotes/up/gone`，外加指向它的符号引用 `up/HEAD`），
    ///   - 只有标签指着的 t（`v-dangling`，附注标签），
    ///   - `refs/notes/*`、`refs/pull/*` 这类 `git log --all` 默认装饰以外的命名空间不算起点。
    fn all_refs_repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let (d, r) = merged_repo();
        git(&r, "1000000006 +0000", &["checkout", "-q", "--orphan", "orphan"]);
        git(&r, "1000000006 +0000", &["commit", "-q", "--allow-empty", "-m", "o1"]);
        git(&r, "1000000009 +0000", &["commit", "-q", "--allow-empty", "-m", "o2"]);
        git(&r, "1000000007 +0000", &["checkout", "-q", "-b", "scratch", "main"]);
        git(&r, "1000000007 +0000", &["commit", "-q", "--allow-empty", "-m", "r"]);
        git(&r, "1000000007 +0000", &["update-ref", "refs/remotes/up/gone", "HEAD"]);
        // 符号引用 up/HEAD -> up/gone 不是分支，不挂装饰
        git(&r, "1000000007 +0000", &["symbolic-ref", "refs/remotes/up/HEAD", "refs/remotes/up/gone"]);
        git(&r, "1000000008 +0000", &["commit", "-q", "--allow-empty", "-m", "t"]);
        git(&r, "1000000008 +0000", &["tag", "-a", "-m", "dangling", "v-dangling"]);
        git(&r, "1000000010 +0000", &["commit", "-q", "--allow-empty", "-m", "pull"]);
        git(&r, "1000000010 +0000", &["update-ref", "refs/pull/1/head", "HEAD"]);
        git(&r, "1000000010 +0000", &["checkout", "-q", "main"]);
        git(&r, "1000000010 +0000", &["branch", "-q", "-D", "scratch"]);
        (d, r)
    }

    #[test]
    fn 与_head_不相连的分支远端和标签都成行() {
        let (_d, r) = all_refs_repo();
        let page = graph(&r, 100, 0, None).unwrap();
        assert_eq!(summaries(&page.rows), ["o2", "t", "r", "o1", "m", "a", "f", "g", "b"], "按提交时间从新到旧");
        assert!(!summaries(&page.rows).contains(&"pull"), "refs/pull 不是起点");
        assert_topological(&page.rows);
        let row = |summary: &str| page.rows.iter().find(|row| row.commit.summary == summary).unwrap();
        assert_eq!(row("o2").refs, ["orphan"]);
        assert_eq!(row("t").refs, ["v-dangling"], "附注标签剥到提交");
        assert_eq!(
            row("r").branches,
            [GraphBranch { reference: "refs/remotes/up/gone".into(), remote: Some("up".into()) }]
        );
        assert_eq!(row("m").head.as_deref(), Some("main"));
        let on_head: Vec<&str> =
            page.rows.iter().filter(|row| row.on_head).map(|row| row.commit.summary.as_str()).collect();
        assert_eq!(on_head, ["m", "a", "f", "g", "b"]);
        assert!(page.rows.iter().all(|row| row.stash.is_none()));
    }

    /// `git rev-list --date-order --exclude=refs/pull/* --all`：GitLens 提交图的 `log --all --date-order` 去掉 refs/pull
    fn git_date_order(r: &Path) -> Vec<String> {
        git(r, "1000000099 +0000", &["rev-list", "--date-order", "--exclude=refs/pull/*", "--all"])
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// 普通提交行的顺序与 `git rev-list --date-order` 逐条相同，读对象和读 commit-graph 两条路径都对照；
    /// 任意页长（1、7、50）逐页带游标读出的每一页都等于 git 序列的对应切片，拼起来与一次读完逐字节相同。
    /// 引用没变时序列走缓存，所以写完 commit-graph 后显式丢掉缓存，让第二轮真的从图里重排。
    fn assert_date_order(r: &Path) {
        let expected = git_date_order(r);
        assert!(!expected.is_empty());
        for with_graph in [false, true] {
            if with_graph {
                git(r, "1000000099 +0000", &["commit-graph", "write", "--reachable"]);
                forget(r);
                assert!(gix::open(r).unwrap().commit_graph_if_enabled().unwrap().is_some(), "commit-graph 要真的打开");
            }
            let whole = graph(r, expected.len() + 1, 0, None).unwrap();
            assert!(whole.done);
            let order: Vec<&str> = whole.rows.iter().map(|row| row.commit.sha.as_str()).collect();
            assert_eq!(order, expected, "commit-graph: {with_graph}");
            assert_topological(&whole.rows);
            let json = serde_json::to_string(&whole.rows).unwrap();
            for limit in [1usize, 7, 50] {
                let mut rows: Vec<GraphRow> = Vec::new();
                let mut cursor = None;
                loop {
                    let page = graph(r, limit, rows.len(), cursor).unwrap();
                    let shas: Vec<&str> = page.rows.iter().map(|row| row.commit.sha.as_str()).collect();
                    let slice = &expected[rows.len()..rows.len() + page.rows.len()];
                    assert_eq!(shas, slice, "commit-graph: {with_graph}，每页 {limit} 条，第 {} 行起", rows.len());
                    rows.extend(page.rows);
                    cursor = Some(page.cursor);
                    if page.done {
                        break;
                    }
                }
                assert_eq!(serde_json::to_string(&rows).unwrap(), json, "commit-graph: {with_graph}，每页 {limit} 条");
            }
        }
    }

    /// 普通提交行的顺序与 `git rev-list --date-order --all`（GitLens 的 `log --all --date-order`，去掉 refs/pull）
    /// 一致：按提交时间，同一秒的靠进队先后，父提交等所有子提交出完
    #[test]
    fn 遍历顺序与_git_rev_list_全部引用一致() {
        let (_d, r) = all_refs_repo();
        // 同一秒的一串提交和一个合并：顺序只能靠进队先后决定
        git(&r, "1000000020 +0000", &["checkout", "-q", "-b", "same", "main"]);
        for name in ["s1", "s2", "s3"] {
            git(&r, "1000000020 +0000", &["commit", "-q", "--allow-empty", "-m", name]);
        }
        git(&r, "1000000020 +0000", &["checkout", "-q", "main"]);
        git(&r, "1000000020 +0000", &["commit", "-q", "--allow-empty", "-m", "s0"]);
        git(&r, "1000000020 +0000", &["merge", "-q", "--no-ff", "-m", "sm", "same"]);
        assert_date_order(&r);
    }

    /// 复现：八个提交全在同一秒。`git log` 的默认顺序（按时间，同一秒按进队先后）会把 Add file 2 排在它的
    /// 后代 Add file 4 之前，泳道就画错；`--date-order` 让父提交等所有子提交出完，同一秒的并列按进队先后。
    #[test]
    fn 同一秒的分支与合并保持拓扑序() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        let t = "1000000000 +0000";
        git(&r, t, &["init", "-q", "-b", "main", "."]);
        git(&r, t, &["config", "user.email", "t@t.t"]);
        git(&r, t, &["config", "user.name", "t"]);
        for name in ["Initial commit", "Add file 1", "Add file 2", "Add file 3"] {
            git(&r, t, &["commit", "-q", "--allow-empty", "-m", name]);
        }
        git(&r, t, &["checkout", "-q", "-b", "side", "HEAD~1"]);
        git(&r, t, &["commit", "-q", "--allow-empty", "-m", "Change b"]);
        git(&r, t, &["checkout", "-q", "main"]);
        for name in ["Add file 4", "Add file 5"] {
            git(&r, t, &["commit", "-q", "--allow-empty", "-m", name]);
        }
        git(&r, t, &["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);

        let page = graph(&r, 100, 0, None).unwrap();
        assert_eq!(
            summaries(&page.rows),
            [
                "Merge side",
                "Add file 5",
                "Change b",
                "Add file 4",
                "Add file 3",
                "Add file 2",
                "Add file 1",
                "Initial commit"
            ],
            "合并的第一个父提交先进队，所以 Add file 5 在 Change b 之前；Add file 2 等到 Change b 与 Add file 3 都出完"
        );
        assert_topological(&page.rows);
        let default_order = git(&r, t, &["log", "--all", "--format=%s"]);
        let default_order: Vec<&str> = default_order.lines().collect();
        assert_ne!(default_order, summaries(&page.rows), "默认顺序确实不是拓扑序，这个夹具才有区分度");
        assert_date_order(&r);
    }

    /// 同一秒里多条分支来回合并、一条没合并的分支和一个标签：并列只靠进队先后
    #[test]
    fn 同一秒多条分支来回合并() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        let t = "1000000000 +0000";
        git(&r, t, &["init", "-q", "-b", "main", "."]);
        git(&r, t, &["config", "user.email", "t@t.t"]);
        git(&r, t, &["config", "user.name", "t"]);
        let commit = |name: &str| git(&r, t, &["commit", "-q", "--allow-empty", "-m", name]);
        commit("a");
        commit("b");
        git(&r, t, &["checkout", "-q", "-b", "x"]);
        commit("x1");
        commit("x2");
        git(&r, t, &["tag", "x-done"]);
        git(&r, t, &["checkout", "-q", "-b", "y", "main"]);
        commit("y1");
        git(&r, t, &["checkout", "-q", "main"]);
        commit("c");
        git(&r, t, &["merge", "-q", "--no-ff", "-m", "mx", "x"]);
        git(&r, t, &["checkout", "-q", "y"]);
        commit("y2");
        git(&r, t, &["merge", "-q", "--no-ff", "-m", "my", "main"]);
        git(&r, t, &["checkout", "-q", "main"]);
        commit("d");
        git(&r, t, &["merge", "-q", "--no-ff", "-m", "md", "y"]);
        git(&r, t, &["checkout", "-q", "-b", "z", "main~3"]);
        commit("z1");
        git(&r, t, &["checkout", "-q", "main"]);
        assert_date_order(&r);
    }

    /// 时钟偏差：子提交比父提交早（a 100 ← b 50 ← c 200），合并比两个父提交都早（m 10 合并 c 200 与 e 300）。
    /// 默认顺序会把 b 的父提交 a 排到 b 前面；`--date-order` 仍是拓扑序，并列按时间
    #[test]
    fn 时钟倒退的历史仍按拓扑序() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        let at = |time: u64| format!("{} +0000", 1000000000 + time);
        git(&r, &at(0), &["init", "-q", "-b", "main", "."]);
        git(&r, &at(0), &["config", "user.email", "t@t.t"]);
        git(&r, &at(0), &["config", "user.name", "t"]);
        git(&r, &at(100), &["commit", "-q", "--allow-empty", "-m", "a"]);
        git(&r, &at(50), &["commit", "-q", "--allow-empty", "-m", "b"]);
        git(&r, &at(200), &["commit", "-q", "--allow-empty", "-m", "c"]);
        git(&r, &at(0), &["checkout", "-q", "-b", "side", "main~2"]);
        git(&r, &at(150), &["commit", "-q", "--allow-empty", "-m", "d"]);
        git(&r, &at(300), &["commit", "-q", "--allow-empty", "-m", "e"]);
        git(&r, &at(0), &["checkout", "-q", "main"]);
        git(&r, &at(10), &["merge", "-q", "--no-ff", "-m", "m", "side"]);

        let page = graph(&r, 100, 0, None).unwrap();
        assert_eq!(summaries(&page.rows), ["m", "e", "c", "d", "b", "a"], "m 虽然最早也先出；a 等 b 和 d 都出完");
        assert_topological(&page.rows);
        let default_order = git(&r, &at(0), &["log", "--all", "--format=%s"]);
        assert_ne!(default_order.lines().collect::<Vec<_>>(), summaries(&page.rows));
        assert_date_order(&r);
    }

    /// 固定种子的伪随机历史：5 条分支、`commits` 个提交，一次 `git fast-import` 写入。提交时间只在 8 秒里
    /// 随机取，所以同一秒的并列很多、子比父早也常见；两成提交是合并；分支第一次提交时一半从别的分支
    /// 分出、一半另起一个根。返回仓库和（同一秒并列数、子比父早的数）。
    fn random_repo(seed: u64, commits: usize) -> (tempfile::TempDir, std::path::PathBuf, (usize, usize)) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, "1000000000 +0000", &["init", "-q", "-b", "main", "."]);
        let mut state = seed;
        let mut rng = move |n: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % n
        };
        let mut tips: [Option<usize>; 5] = [None; 5];
        let mut times: Vec<u64> = vec![0];
        let mut script = String::new();
        let (mut ties, mut skews) = (0, 0);
        for mark in 1..=commits {
            let branch = rng(5) as usize;
            let time = 1000000000 + rng(8);
            let first = tips[branch].or_else(|| {
                let others: Vec<usize> = tips.iter().flatten().copied().collect();
                if others.is_empty() || rng(2) == 0 { None } else { Some(others[rng(others.len() as u64) as usize]) }
            });
            let merge = (rng(5) == 0)
                .then(|| {
                    let others: Vec<usize> = tips.iter().flatten().copied().filter(|tip| Some(*tip) != first).collect();
                    (!others.is_empty()).then(|| others[rng(others.len() as u64) as usize])
                })
                .flatten();
            for parent in first.into_iter().chain(merge) {
                ties += usize::from(times[parent] == time);
                skews += usize::from(times[parent] > time);
            }
            let message = format!("c{mark}");
            script.push_str(&format!(
                "commit refs/heads/b{branch}\nmark :{mark}\ncommitter t <t@t.t> {time} +0000\ndata {}\n{message}\n",
                message.len()
            ));
            if let Some(parent) = first {
                script.push_str(&format!("from :{parent}\n"));
            }
            if let Some(parent) = merge {
                script.push_str(&format!("merge :{parent}\n"));
            }
            script.push('\n');
            tips[branch] = Some(mark);
            times.push(time);
        }
        use std::io::Write as _;
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&r)
            .args(["fast-import", "--quiet"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "fast-import: {}", String::from_utf8_lossy(&out.stderr));
        git(&r, "1000000000 +0000", &["symbolic-ref", "HEAD", "refs/heads/b0"]);
        (d, r, (ties, skews))
    }

    #[test]
    fn 随机历史与_git_date_order_逐页相同() {
        for seed in [0x9e37_79b9_7f4a_7c15u64, 0x2545_f491_4f6c_dd1d] {
            let (_d, r, (ties, skews)) = random_repo(seed, 300);
            assert!(ties >= 25 && skews >= 60, "夹具要真的有很多并列和时钟倒退：{ties} 处同一秒，{skews} 处子比父早");
            let default_order = git(&r, "1000000000 +0000", &["rev-list", "--all"]);
            assert_ne!(default_order.lines().collect::<Vec<_>>(), git_date_order(&r), "默认顺序与 --date-order 要不同");
            assert_date_order(&r);
        }
    }

    /// 序列按起点缓存：起点没变（含只换 HEAD）不重排，提交、打标签都换掉同一仓库的条目
    #[test]
    fn 序列按起点缓存_起点变了才重排() {
        let (_d, r) = merged_repo();
        let git_dir = gix::open(&r).unwrap().git_dir().to_path_buf();
        assert_eq!(order::len(), 0);
        graph(&r, 2, 0, None).unwrap();
        assert_eq!(order::len(), 1);
        let first = order::cached(&git_dir).unwrap();
        graph(&r, 2, 2, None).unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &order::cached(&git_dir).unwrap()), "翻页走缓存");

        git(&r, "1000000006 +0000", &["checkout", "-q", "feature"]);
        let page = graph(&r, 100, 0, None).unwrap();
        assert_eq!(page.rows[2].head.as_deref(), Some("feature"));
        assert!(std::sync::Arc::ptr_eq(&first, &order::cached(&git_dir).unwrap()), "HEAD 换了、起点没变，不重排");

        git(&r, "1000000006 +0000", &["commit", "-q", "--allow-empty", "-m", "n"]);
        let page = graph(&r, 100, 0, None).unwrap();
        assert_eq!(summaries(&page.rows)[0], "n", "新提交在第一行");
        let second = order::cached(&git_dir).unwrap();
        assert!(!std::sync::Arc::ptr_eq(&first, &second), "起点变了就重排");
        assert_eq!(order::len(), 1, "同一仓库只留最新的一条");

        git(&r, "1000000006 +0000", &["tag", "old", "v1"]);
        graph(&r, 100, 0, None).unwrap();
        assert!(std::sync::Arc::ptr_eq(&second, &order::cached(&git_dir).unwrap()), "指向同一提交的新标签不是新起点");
        git(&r, "1000000006 +0000", &["tag", "mid", "main~1"]);
        graph(&r, 100, 0, None).unwrap();
        assert!(!std::sync::Arc::ptr_eq(&second, &order::cached(&git_dir).unwrap()), "多一个起点也是新键");
        forget(&r);
        assert_eq!(order::len(), 0);
    }

    #[test]
    fn 缓存最多留_max_个仓库() {
        let repos: Vec<_> = (0..order::MAX + 1).map(|_| merged_repo()).collect();
        for (_, r) in &repos {
            graph(r, 1, 0, None).unwrap();
        }
        assert_eq!(order::len(), order::MAX);
        assert!(order::cached(gix::open(&repos[0].1).unwrap().git_dir()).is_none(), "最早没用过的先丢");
        assert!(order::cached(gix::open(&repos[1].1).unwrap().git_dir()).is_some());
    }

    /// 浅克隆边界上的提交没有父提交（和 `git log` 一样），泳道在边界收掉，不报错
    #[test]
    fn 浅克隆在边界结束() {
        let (_d, r) = merged_repo();
        let d = tempfile::tempdir().unwrap();
        let url = format!("file://{}", r.display());
        git(
            d.path(),
            "1000000006 +0000",
            &["clone", "-q", "--depth", "2", "--single-branch", "--branch", "main", "--no-tags", &url, "shallow"],
        );
        let page = graph(&d.path().join("shallow"), 100, 0, None).unwrap();
        assert_eq!(summaries(&page.rows), ["m", "a", "f"]);
        assert!(page.rows[1].commit.parent_sh_as.is_empty() && page.rows[2].commit.parent_sh_as.is_empty());
        assert!(page.rows.last().unwrap().lanes.is_empty());
    }

    /// main 上 b、c；在 c 上建两个贮藏（第二个带未跟踪文件，第三个父提交），再切到 side 分支
    /// 提交 s，在 s 上建第三个贮藏后删掉 side：这个贮藏的基提交只剩贮藏指着。
    fn stash_repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, "1000000001 +0000", &["init", "-q", "-b", "main", "."]);
        git(&r, "1000000001 +0000", &["config", "user.email", "t@t.t"]);
        git(&r, "1000000001 +0000", &["config", "user.name", "t"]);
        std::fs::write(r.join("a.txt"), "a\n").unwrap();
        git(&r, "1000000001 +0000", &["add", "a.txt"]);
        git(&r, "1000000001 +0000", &["commit", "-q", "-m", "b"]);
        git(&r, "1000000002 +0000", &["commit", "-q", "--allow-empty", "-m", "c"]);
        std::fs::write(r.join("a.txt"), "first\n").unwrap();
        git(&r, "1000000003 +0000", &["stash", "push", "-q", "-m", "first"]);
        std::fs::write(r.join("a.txt"), "second\n").unwrap();
        std::fs::write(r.join("new.txt"), "untracked\n").unwrap();
        git(&r, "1000000004 +0000", &["stash", "push", "-q", "-u", "-m", "second"]);
        git(&r, "1000000005 +0000", &["checkout", "-q", "-b", "side"]);
        git(&r, "1000000005 +0000", &["commit", "-q", "--allow-empty", "-m", "s"]);
        std::fs::write(r.join("a.txt"), "third\n").unwrap();
        git(&r, "1000000006 +0000", &["stash", "push", "-q", "-m", "third"]);
        git(&r, "1000000006 +0000", &["checkout", "-q", "main"]);
        git(&r, "1000000006 +0000", &["branch", "-q", "-D", "side"]);
        git(&r, "1000000007 +0000", &["commit", "-q", "--allow-empty", "-m", "d"]);
        (d, r)
    }

    #[test]
    fn 每个贮藏单独成行且只连基提交() {
        let (_d, r) = stash_repo();
        let page = graph(&r, 100, 0, None).unwrap();
        assert_eq!(
            summaries(&page.rows),
            ["d", "On side: third", "s", "On main: second", "On main: first", "c", "b"],
            "贮藏按时间插进序列，基提交已删分支的 s 也遍历到"
        );
        assert_topological(&page.rows);
        let stash = |n: usize| page.rows.iter().find(|row| row.stash == Some(n)).unwrap();
        let sha = |rev: &str| git(&r, "1000000008 +0000", &["rev-parse", rev]);
        for n in 0..3 {
            let row = stash(n);
            assert_eq!(row.commit.sha, sha(&format!("stash@{{{n}}}")), "stash@{{{n}}} 的序号");
            assert_eq!(row.commit.parent_sh_as, [sha(&format!("stash@{{{n}}}^1"))], "只连基提交");
            assert_eq!(row.commit.parent_count, 1);
            assert!(!row.on_head && row.refs.is_empty());
        }
        // 索引、未跟踪文件两个内部提交不成行
        let internal = [sha("stash@{0}^2"), sha("stash@{1}^2"), sha("stash@{1}^3"), sha("stash@{2}^2")];
        assert!(page.rows.iter().all(|row| !internal.contains(&row.commit.sha)));
        assert_eq!(page.rows.iter().filter(|row| row.stash.is_none()).count(), 4);
        assert!(!page.rows.iter().find(|row| row.commit.summary == "s").unwrap().on_head);
    }

    /// 全部引用和贮藏一起遍历时，任意页长逐页读完与一次读完逐字节相同（泳道、色流、贮藏行、HEAD 标记）
    #[test]
    fn 全部引用与贮藏分页逐字节相同() {
        let (_d, r) = all_refs_repo();
        std::fs::write(r.join("x.txt"), "x\n").unwrap();
        git(&r, "1000000011 +0000", &["stash", "push", "-q", "-u", "-m", "on main"]);
        git(&r, "1000000012 +0000", &["checkout", "-q", "feature"]);
        std::fs::write(r.join("y.txt"), "y\n").unwrap();
        git(&r, "1000000003 +0000", &["stash", "push", "-q", "-u", "-m", "on feature"]);
        git(&r, "1000000012 +0000", &["checkout", "-q", "main"]);

        let whole = graph(&r, 1000, 0, None).unwrap();
        assert!(whole.done);
        assert_eq!(whole.rows.len(), 11);
        assert_eq!(whole.rows.iter().filter(|row| row.stash.is_some()).count(), 2);
        assert_topological(&whole.rows);
        let widest = whole.rows.iter().map(|row| row.lanes.len()).max().unwrap();
        assert!(widest >= 3, "夹具要真的同时有多条泳道：{widest}");
        let expected = serde_json::to_string(&whole.rows).unwrap();

        for size in 1..=whole.rows.len() + 1 {
            let mut rows = Vec::new();
            let mut cursor = None;
            loop {
                let page = graph(&r, size, rows.len(), cursor).unwrap();
                rows.extend(page.rows);
                cursor = Some(page.cursor);
                if page.done {
                    break;
                }
            }
            assert_eq!(serde_json::to_string(&rows).unwrap(), expected, "每页 {size} 条");
        }
    }

    #[test]
    fn 空仓库返回空页() {
        let d = tempfile::tempdir().unwrap();
        git(d.path(), "1000000001 +0000", &["init", "-q", "-b", "main", "."]);
        let page = graph(d.path(), 100, 0, None).unwrap();
        assert!(page.rows.is_empty());
        assert!(page.done);
    }
}
