//! `git blame --porcelain [<rev>] -- <path>` 的进程内实现。
//!
//! 算法照 git v2.54.0 `blame.c`（与打包的 dugite git 2.53.0 在这条路径上相同）：
//! `assign_blame` 按提交时间的优先队列（`prio_queue`，同一时间先入先出）取出提交，对它名下每个还有
//! 待定行的 origin 调 `pass_blame`：
//!
//! 1. 两遍找替罪羊（`first_scapegoat` 的父提交顺序）：第一遍 `find_origin` 只看同一路径
//!    （父提交树里这个路径的条目与子提交相同就沿用子提交的 blob，否则取父提交的 blob；父提交里
//!    没有这个路径、或类型变了就没有），第二遍对还没找到的父提交 `find_rename`：父子两棵树整体做
//!    diffcore-rename（`DIFF_DETECT_RENAME`，`single_follow` 只认这一个新增路径作目标，来源是全部删除，
//!    复用 `crate::rename`）。任一父提交的 blob 和子提交相同就整份交给它（`pass_whole_blame`），
//!    与更早的父提交 blob 相同的父提交跳过。
//! 2. 按父提交顺序 `pass_blame_to_parent`：父 → 子跑 xdiff（`xdi_diff`：零上下文先 `trim_common_tail`，
//!    Myers + 缩进启发，见 `crate::xdiff::blame_hunks`），落在改动块外的行交给父提交，块内的留下；
//!    第一个分到行的父提交记作 `previous`。
//! 3. 根提交（没有父提交）在 `blame.showRoot` 关着时是边界（porcelain 的 `boundary`）。
//!
//! 剩下的行由这个 origin 负责。行移动、复制检测（`-M`/`-C`）、`--first-parent`、忽略提交都不在
//! Desktop 的参数里，没有实现。每一行最终归谁只取决于它沿哪条父链走、每一步的 diff，与 origin 的
//! 处理先后无关；输出前按最终行号排序并合并相邻的连续段（`blame_coalesce`），所以拆段方式不影响字节。
//!
//! 不带 `<rev>` 时照 `fake_working_tree_commit` 造一个全零的「提交」：父提交是 HEAD（合并中再接上
//! MERGE_HEAD 里的提交），内容是工作区文件（未合并的文件照样取工作区内容），
//! 作者与提交者都是 `Not Committed Yet <not.committed.yet>`、时间为现在，摘要
//! `Version of <path> from <path>`。
//!
//! 输出照 builtin/blame.c `emit_porcelain`：每个提交第一次出现时写完整头部（作者、提交者——有 mailmap 时让位、
//! `summary`、边界时 `boundary`），带头部或这个提交有不止一个路径负责行（`MORE_THAN_ONE_PATH`）
//! 时写 `previous` 与 `filename`（`core.quotePath` 决定的 C 风格引号）。含 NUL 的 blob 照样按行比较。
//!
//! 性能不靠改算法：路径查找沿第一父链按批预取（批量翻倍），批里第一父提交 blob 不同的合并提交
//! 接着预取其余父链（`pass_blame` 一定会查它们，批次满了就留到下一批先走）；大批次交给本次 blame
//! 常驻的工作线程按小段并行，查完一批后把 `pass_blame` 会做的相邻两版 diff 也并行先算好（diff 只取决于两份内容）。
//! 树和 blob 经 `crate::pack_reader` 读，delta 链上每一级都缓存。
//!
//! `Err` 只表示「这次交给 git」：mailmap、`blame.ignoreRevsFile`、改了 diff 算法或缩进启发、
//! 会改变内容的属性（textconv、行尾、filter 等）、浅克隆、移植、替换对象、非 UTF-8 编码的提交、
//! 路径在某个版本里是目录、超过 16 MiB 的 blob、缺对象，以及
//! `crate::rename` 让位的重命名检测设置。

use crate::raw_diff::in_process as rd;
use crate::rename::{Change, RepoBlobs, Side};
use gix::ObjectId;
use gix::bstr::{BStr, ByteSlice};
use gix::object::tree::EntryKind;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::hash::BuildHasherDefault;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::changed_paths::{ChangedPaths, Key};
use crate::pack_reader::{PackReader, Packs};

type Fallback = String;

/// 对象名和下标做键的表用的哈希（FxHash 的乘法混合）：键是 SHA 或本次 blame 自己编的号，
/// 不是仓库内容能随意构造的；路径做键的表仍用标准库的 SipHash。
#[derive(Default, Clone, Copy)]
struct Fx(u64);

impl Fx {
    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

impl std::hash::Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.add(u64::from_ne_bytes(word));
        }
    }
    fn write_u32(&mut self, value: u32) {
        self.add(u64::from(value));
    }
    fn write_u64(&mut self, value: u64) {
        self.add(value);
    }
    fn write_usize(&mut self, value: usize) {
        self.add(value as u64);
    }
}

type HashMap<K, V> = std::collections::HashMap<K, V, BuildHasherDefault<Fx>>;
type HashSet<T> = std::collections::HashSet<T, BuildHasherDefault<Fx>>;

/// 超过这个大小的 blob 交给 git（与其他快速路径相同）
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;
/// 预取一条父链时一批的上下限：先小后大，历史短的文件不白查
const FIRST_BATCH: usize = 64;
const MAX_BATCH: usize = 1024;
/// 小于这个数的批次在本线程查，起线程比查还贵
const PARALLEL_MIN: usize = 8;
/// 最多用几个线程
const MAX_THREADS: usize = 8;
/// 交错分给线程时每段的长度
const BLOCK: usize = 32;
/// 先算的 diff 每次发给一个线程几对：按链上顺序相邻的两版共用包里的 delta 基
const DIFF_CHUNK: usize = 4;
/// 有 Bloom 过滤器时预取沿一条链最多走多少个提交（大多数提交不用查，只走不查）
const WALK_LIMIT: usize = 4096;

/// 树里一个路径的条目：不存在、是目录、或一个非目录条目（规范化后的模式与对象）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Found {
    Missing,
    Tree,
    Leaf { mode: u32, id: ObjectId },
}

/// git `canon_mode`
fn canon_mode(kind: EntryKind) -> u32 {
    match kind {
        EntryKind::Tree => 0o040000,
        EntryKind::Blob => 0o100644,
        EntryKind::BlobExecutable => 0o100755,
        EntryKind::Link => 0o120000,
        EntryKind::Commit => 0o160000,
    }
}

/// 一段待定或已定的行：最终文件里从 `lno` 起、在 suspect 里从 `s_lno` 起的 `num` 行（从 0 数）。
#[derive(Clone, Copy, Debug)]
struct Entry {
    lno: usize,
    s_lno: usize,
    num: usize,
}

/// blame.h `struct blame_origin`：某个提交里的某个路径。
struct Origin {
    commit: usize,
    path: usize,
    blob: ObjectId,
    mode: u32,
    previous: Option<usize>,
    /// 按 `s_lno` 排序
    suspects: Vec<Entry>,
}

struct Commit {
    id: ObjectId,
    date: u64,
    tree: ObjectId,
    parent_ids: Vec<ObjectId>,
    /// 父提交在 commit-graph 里的位置（这个提交从 commit-graph 读到时才有）
    parent_positions: Vec<gix::commitgraph::Position>,
    parents: Option<Vec<usize>>,
    /// `maybe_changed_path` 的结果和当时的键数
    maybe: Option<(usize, bool)>,
    /// 这个提交名下的 origin，`get_origin` 的链表顺序（最近用到的在前）
    origins: Vec<usize>,
    boundary: bool,
}

/// 不带修订号时的工作区「提交」
struct Fake {
    commit: usize,
    content: Arc<Vec<u8>>,
    blob: ObjectId,
    /// fake_working_tree_commit 拼出来的提交内容（作者、提交者、摘要都从这里解析）
    buffer: Vec<u8>,
}

/// 一个线程查路径用的仓库句柄与缓存。
struct Probe {
    repo: gix::Repository,
    reader: PackReader,
    /// (树, 名字编号) → 这个名字在树里的条目；不同路径共用前缀时也能命中
    entries: HashMap<(ObjectId, u32), Option<(EntryKind, ObjectId)>>,
    buffer: Vec<u8>,
}

impl Probe {
    fn new(mut repo: gix::Repository, packs: Arc<Packs>) -> Self {
        repo.objects.unset_object_cache();
        Probe { repo, reader: PackReader::new(packs), entries: HashMap::default(), buffer: Vec::new() }
    }

    fn entry(&mut self, tree: ObjectId, name_id: u32, name: &[u8]) -> Result<Option<(EntryKind, ObjectId)>, Fallback> {
        use gix::objs::FindExt;
        if let Some(found) = self.entries.get(&(tree, name_id)) {
            return Ok(*found);
        }
        let mut found = None;
        let packed = self.reader.object(&tree).filter(|(kind, _)| *kind == gix::objs::Kind::Tree);
        let entries = match &packed {
            Some((_, data)) => gix::objs::TreeRefIter::from_bytes(data, tree.kind()),
            None => self.repo.objects.find_tree_iter(&tree, &mut self.buffer).map_err(|e| e.to_string())?,
        };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.filename.as_ref() as &[u8] == name {
                found = Some((entry.mode.kind(), entry.oid.to_owned()));
                break;
            }
        }
        self.entries.insert((tree, name_id), found);
        Ok(found)
    }

    /// 读一个 blob：先走带 delta 基缓存的包读取，读不了再用 gix。
    fn blob(&mut self, id: ObjectId) -> Result<Arc<Vec<u8>>, Fallback> {
        let (kind, data) = match self.reader.object(&id) {
            Some(found) => found,
            None => {
                let object = self.repo.find_object(id).map_err(|e| e.to_string())?;
                (object.kind, Arc::new(object.detach().data))
            }
        };
        if kind != gix::object::Kind::Blob {
            return Err(format!("{id} 不是 blob"));
        }
        if data.len() as u64 > MAX_FILE_SIZE {
            return Err("文件太大".into());
        }
        Ok(data)
    }

    /// 读过的 blob 在包读取缓存里。已被别的线程（包括要用它的主线程）认领的不算，
    /// 但也回一条，主线程据此不再等它。
    fn diff_pairs(&mut self, pairs: &[(ObjectId, ObjectId)], claimed: &Claimed) -> Vec<DiffResult> {
        pairs
            .iter()
            .map(|&pair| {
                if !claimed.lock().is_ok_and(|mut claimed| claimed.insert(pair)) {
                    return (pair, Diffed::Skipped);
                }
                let hunks = (|| {
                    let base = self.blob(pair.0).ok()?;
                    let child = self.blob(pair.1).ok()?;
                    Some(crate::xdiff::blame_hunks(&base, &child))
                })();
                (pair, hunks.map_or(Diffed::Unreadable, Diffed::Hunks))
            })
            .collect()
    }

    fn lookup(&mut self, tree: ObjectId, components: &[(u32, Vec<u8>)]) -> Result<Found, Fallback> {
        let last = components.len() - 1;
        let mut tree = tree;
        for (depth, (name_id, name)) in components.iter().enumerate() {
            match self.entry(tree, *name_id, name)? {
                None => return Ok(Found::Missing),
                Some((EntryKind::Tree, id)) if depth < last => tree = id,
                Some((EntryKind::Tree, _)) => return Ok(Found::Tree),
                Some((kind, id)) if depth == last => return Ok(Found::Leaf { mode: canon_mode(kind), id }),
                Some(_) => return Ok(Found::Missing),
            }
        }
        unreachable!("the loop returns at the last component")
    }
}

type Components = Arc<Vec<(u32, Vec<u8>)>>;

/// 发给查路径线程的活：一批路径查找里归它的那几份（`first`／`step`）。
struct Job {
    batch: Arc<Vec<(usize, ObjectId, usize)>>,
    components: Components,
    stops: Arc<Vec<std::sync::atomic::AtomicUsize>>,
    first: usize,
    step: usize,
}

type Reply = Vec<(usize, Result<Found, Fallback>)>;

/// 一次 blame 期间常驻的查路径线程（每次起线程要几十微秒，批次多时比活还贵）
struct Pool {
    jobs: Vec<std::sync::mpsc::Sender<Job>>,
    replies: std::sync::mpsc::Receiver<Reply>,
}

fn run_job(probe: &mut Probe, job: Job) -> Reply {
    lookup_share(probe, &job.batch, &job.components, &job.stops, job.first, job.step)
}

/// 一对 (父 blob, 子 blob) 和先算的结果
type DiffResult = ((ObjectId, ObjectId), Diffed);

enum Diffed {
    Hunks(Vec<[usize; 4]>),
    /// 读不了或太大：到时候照常走 `read_blob` 让位
    Unreadable,
    /// 别的线程已经认领
    Skipped,
}

/// 已经有线程开始算的 diff
type Claimed = Arc<std::sync::Mutex<std::collections::HashSet<(ObjectId, ObjectId), BuildHasherDefault<Fx>>>>;

/// 先算 diff 的线程：预取时发过去就不等，`pass_blame_to_parent` 用到时才收。
/// diff 只取决于两份内容，谁先算完、在哪个线程算都不影响结果。
/// 查路径的线程另成一组：排在 diff 后面的查找不必等这些 diff。
struct DiffPool {
    jobs: std::sync::mpsc::Sender<Vec<(ObjectId, ObjectId)>>,
    results: std::sync::mpsc::Receiver<Vec<DiffResult>>,
    /// blame 结束（或让位）后排着的 diff 不再算
    done: Arc<std::sync::atomic::AtomicBool>,
    claimed: Claimed,
}

impl Drop for DiffPool {
    fn drop(&mut self) {
        self.done.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// 连续的一小段归同一线程：相邻提交共用大部分子树，留在同一个线程的缓存里
fn lookup_share(
    probe: &mut Probe, batch: &[(usize, ObjectId, usize)], components: &[(u32, Vec<u8>)],
    stops: &[std::sync::atomic::AtomicUsize], first: usize, step: usize,
) -> Vec<(usize, Result<Found, Fallback>)> {
    use std::sync::atomic::Ordering;
    let mut out = Vec::new();
    let blocks = (first * BLOCK..batch.len()).step_by(step * BLOCK);
    for index in blocks.flat_map(|start| start..(start + BLOCK).min(batch.len())) {
        let (_, tree, chain) = batch[index];
        if index > stops[chain].load(Ordering::Relaxed) {
            continue;
        }
        let result = probe.lookup(tree, components);
        if matches!(result, Ok(Found::Missing | Found::Tree)) {
            stops[chain].fetch_min(index, Ordering::Relaxed);
        }
        out.push((index, result));
    }
    out
}

/// 读这些设置的结果；任何一项要求让位就 `Err`。
struct Settings {
    show_root: bool,
    quote_fully: bool,
    /// `core.autocrlf` 不是 false
    autocrlf: bool,
}

fn check_settings(repo: &gix::Repository, path: &str) -> Result<Settings, Fallback> {
    if let Some(key) = rd::RELEVANT_ENV.iter().find(|key| std::env::var_os(key).is_some()) {
        return Err((*key).into());
    }
    let config = rd::config(repo)?;
    for key in ["diff.algorithm", "blame.ignoreRevsFile", "mailmap.file", "mailmap.blob"] {
        if config.present(key) {
            return Err(key.into());
        }
    }
    if config.present("diff.indentHeuristic") && config.boolean("diff.indentHeuristic")? != Some(true) {
        return Err("diff.indentHeuristic".into());
    }
    // convert.c `git_config_core`：`input` 或布尔值
    let autocrlf = match config.string("core.autocrlf") {
        Some(value) if value.eq_ignore_ascii_case(b"input") => true,
        Some(_) => config.boolean("core.autocrlf")?.unwrap_or(false),
        None => false,
    };
    // 只影响非 porcelain 输出，但写错时 git 读配置就会失败：布尔值要能解析，日期和颜色出现即让位
    for key in ["blame.blankBoundary", "blame.showEmail", "blame.markUnblamableLines", "blame.markIgnoredLines"] {
        config.boolean(key)?;
    }
    for key in ["blame.date", "color.blame.highlightRecent", "color.blame.repeatedLines"] {
        if config.present(key) {
            return Err(key.into());
        }
    }
    if config.present("blame.coloring") && config.string("blame.coloring").is_none() {
        return Err("blame.coloring".into());
    }
    if let Some(encoding) = config.string("i18n.logOutputEncoding")
        && !crate::history::log_format::is_utf8_name(encoding.to_str_lossy().trim())
    {
        return Err("i18n.logOutputEncoding".into());
    }
    if !path.is_ascii()
        && config.boolean("core.precomposeUnicode")?.unwrap_or(false)
        && (gix::utils::str::precompose(path.into()) != path || path.chars().any(|c| c > '\u{ffff}'))
    {
        return Err("路径需要 precompose".into());
    }
    let show_root = config.boolean("blame.showRoot")?.unwrap_or(false);
    let quote_fully = config.boolean("core.quotePath")?.unwrap_or(true);
    Ok(Settings { show_root, quote_fully, autocrlf })
}

/// 打开仓库并检查让位条件。
fn open(root: &Path, path: &str) -> Result<(gix::Repository, Settings), Fallback> {
    rd::check_path(path)?;
    let repo = rd::open(root)?;
    if repo.is_shallow().map_err(|e| e.to_string())? {
        return Err("浅克隆".into());
    }
    if repo.common_dir().join("info").join("grafts").exists() {
        return Err("info/grafts".into());
    }
    let references = repo.references().map_err(|e| e.to_string())?;
    if references.prefixed("refs/replace/").map_err(|e| e.to_string())?.next().is_some() {
        return Err("refs/replace".into());
    }
    drop(references);
    let workdir = repo.workdir().ok_or("裸仓库")?;
    // read_mailmap：工作区根目录的 .mailmap（不跟随符号链接，存在就让位）
    if std::fs::symlink_metadata(workdir.join(".mailmap")).is_ok() {
        return Err(".mailmap".into());
    }
    let settings = check_settings(&repo, path)?;
    Ok((repo, settings))
}

/// 一次 blame 各段在主线程上的墙钟耗时（并行的预取按整段计）与计数，基准分段用。
#[derive(Default, Clone, Debug)]
pub(crate) struct Profile {
    /// 打开仓库、检查设置、起线程、读最终版本
    pub setup: Duration,
    /// 路径查找（读树）
    pub lookup: Duration,
    /// 预取后并行先算的 diff（含读两版 blob）
    pub diff: Duration,
    /// 到时候在本线程现算的 diff
    pub diff_inline: Duration,
    /// 重命名检测
    pub rename: Duration,
    /// 读提交、写 porcelain
    pub output: Duration,
    /// `pass_blame` 处理过的 origin 数
    pub passes: usize,
    /// 查过路径的 (提交, 路径) 数
    pub lookups: usize,
    /// 预取时并行先算的 diff 数与到时候在本线程现算的 diff 数
    pub diffs_ahead: usize,
    pub diffs_inline: usize,
    /// 上一批满了没走、这一批接着走的支链起点数
    pub carried: usize,
}

/// `git blame --porcelain [<revision>] -- <path>` 的输出。`revision` 为 `None` 时 blame 工作区文件；
/// 否则只接受 `HEAD` 或完整的提交对象名。
pub(crate) fn porcelain(root: &Path, revision: Option<&str>, path: &str) -> Result<Vec<u8>, Fallback> {
    porcelain_profiled(root, revision, path).map(|(out, _)| out)
}

/// 同 `porcelain`，另外返回分段耗时。
pub(crate) fn porcelain_profiled(
    root: &Path, revision: Option<&str>, path: &str,
) -> Result<(Vec<u8>, Profile), Fallback> {
    let started = Instant::now();
    let (repo, settings) = open(root, path)?;
    let changed_paths = ChangedPaths::load(&repo, &rd::config(&repo)?)?;
    let attributes = rd::attribute_lister(&repo)?;
    let threads = std::thread::available_parallelism().map_or(1, usize::from).clamp(1, MAX_THREADS);
    let packs = Arc::new(Packs::open(&repo));
    std::thread::scope(|scope| {
        let (reply, replies) = std::sync::mpsc::channel();
        let jobs = (1..threads)
            .map(|_| {
                let (jobs, receiver) = std::sync::mpsc::channel();
                let mut probe = Probe::new(repo.clone(), packs.clone());
                let reply = reply.clone();
                scope.spawn(move || {
                    for job in receiver {
                        if reply.send(run_job(&mut probe, job)).is_err() {
                            break;
                        }
                    }
                });
                jobs
            })
            .collect();
        let pool = Pool { jobs, replies };
        // 先算 diff 的线程到第一次有 diff 要算时才起：只查几个提交的 blame 不白起线程
        let diff_repo = repo.clone();
        let diff_packs = packs.clone();
        let spawn_diffs = move || {
            let (jobs, receiver) = std::sync::mpsc::channel::<Vec<(ObjectId, ObjectId)>>();
            let (result, results) = std::sync::mpsc::channel();
            let receiver = Arc::new(std::sync::Mutex::new(receiver));
            let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let claimed = Claimed::default();
            for _ in 1..threads {
                let mut probe = Probe::new(diff_repo.clone(), diff_packs.clone());
                let (receiver, result, done) = (receiver.clone(), result.clone(), done.clone());
                let claimed = claimed.clone();
                scope.spawn(move || {
                    loop {
                        let job = receiver.lock().map_err(drop).and_then(|jobs| jobs.recv().map_err(drop));
                        let Ok(pairs) = job else { break };
                        if done.load(std::sync::atomic::Ordering::Relaxed) {
                            continue;
                        }
                        if result.send(probe.diff_pairs(&pairs, &claimed)).is_err() {
                            break;
                        }
                    }
                });
            }
            DiffPool { jobs, results, done, claimed }
        };
        let mut blame = Blame::new(&repo, settings, attributes, Probe::new(repo.clone(), packs.clone()), pool);
        if threads > 1 {
            blame.spawn_diffs = Some(Box::new(spawn_diffs));
        }
        // setup_blame_bloom_data：第一个键是要 blame 的路径
        if let Some(changed_paths) = changed_paths {
            blame.bloom_keys.push(changed_paths.key(path.as_bytes()));
            blame.bloom = Some(changed_paths);
        }
        run(blame, root, revision, path, started)
    })
}

fn run(
    mut blame: Blame, root: &Path, revision: Option<&str>, path: &str, started: Instant,
) -> Result<(Vec<u8>, Profile), Fallback> {
    let path_id = blame.intern(path.as_bytes());
    let (origin, final_buf) = match revision {
        None => blame.setup_worktree(root, path)?,
        Some(revision) => blame.setup_commit(revision, path_id)?,
    };
    let lines = line_starts(&final_buf);
    if lines.len() > 1 {
        blame.origins[origin].suspects.push(Entry { lno: 0, s_lno: 0, num: lines.len() - 1 });
    }
    let commit = blame.origins[origin].commit;
    blame.push(commit);
    // 最终版本的路径查找算在准备里
    blame.profile.setup = started.elapsed();
    blame.profile.lookup = Duration::ZERO;
    blame.assign()?;
    let output = Instant::now();
    let out = blame.output(&final_buf, &lines)?;
    blame.profile.output += output.elapsed();
    blame.profile.lookups = blame.found.len();
    Ok((out, blame.profile))
}

/// blame.c `find_line_starts`：每行的起点，最后多一个文件长度。
fn line_starts(buf: &[u8]) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut pos = 0;
    while pos < buf.len() {
        starts.push(pos);
        pos = buf[pos..].iter().position(|b| *b == b'\n').map_or(buf.len(), |i| pos + i + 1);
    }
    starts.push(buf.len());
    starts
}

struct Blame<'r> {
    repo: &'r gix::Repository,
    graph: Option<gix::commitgraph::Graph>,
    hexsz: usize,
    settings: Settings,
    attributes: rd::AttributeList<'r>,
    commits: Vec<Commit>,
    by_id: HashMap<ObjectId, usize>,
    origins: Vec<Origin>,
    paths: Vec<Vec<u8>>,
    /// 这个路径已经过属性检查
    attributes_checked: Vec<bool>,
    components: Vec<Components>,
    path_ids: std::collections::HashMap<Vec<u8>, usize>,
    name_ids: std::collections::HashMap<Vec<u8>, u32>,
    /// 每个路径下一批预取多少个提交
    batch: Vec<usize>,
    /// 每个路径上次预取时批次已满、还没走的支链起点
    frontier: Vec<Vec<usize>>,
    /// 提前算好的 (父 blob, 子 blob) → blame 用的 diff 块
    hunks: HashMap<(ObjectId, ObjectId), Vec<[usize; 4]>>,
    /// (父提交, 路径) → 等这个父提交查到后才能决定要不要先算 diff 的子提交
    waiters: HashMap<(ObjectId, usize), Vec<usize>>,
    /// 已发给先算 diff 的线程、结果还没收的
    pending: HashSet<(ObjectId, ObjectId)>,
    diffs: Option<DiffPool>,
    spawn_diffs: Option<Box<dyn FnOnce() -> DiffPool + 'r>>,
    found: HashMap<(usize, usize), Found>,
    /// 本线程用的那份；其余线程各有一份，在 `pool` 里
    probe: Probe,
    pool: Pool,
    heap: BinaryHeap<(u64, Reverse<u64>, usize)>,
    seq: u64,
    blobs: HashMap<ObjectId, Arc<Vec<u8>>>,
    rename_blobs: Option<RepoBlobs<'r>>,
    rename_limit: Option<u64>,
    fake: Option<Fake>,
    finals: Vec<(usize, Entry)>,
    profile: Profile,
    /// commit-graph 的 changed-path 过滤器；没有或 git 不会用时为 `None`
    bloom: Option<ChangedPaths>,
    /// `blame_bloom_data.keys`：要 blame 的路径加上之后每个重命名来源，只增不减
    bloom_keys: Vec<Key>,
}

impl<'r> Blame<'r> {
    fn new(
        repo: &'r gix::Repository, settings: Settings, attributes: rd::AttributeList<'r>, probe: Probe, pool: Pool,
    ) -> Self {
        Blame {
            repo,
            graph: repo.commit_graph_if_enabled().ok().flatten(),
            hexsz: repo.object_hash().len_in_hex(),
            settings,
            attributes,
            commits: Vec::new(),
            by_id: HashMap::default(),
            origins: Vec::new(),
            paths: Vec::new(),
            attributes_checked: Vec::new(),
            components: Vec::new(),
            path_ids: std::collections::HashMap::default(),
            name_ids: std::collections::HashMap::default(),
            batch: Vec::new(),
            frontier: Vec::new(),
            hunks: HashMap::default(),
            waiters: HashMap::default(),
            pending: HashSet::default(),
            diffs: None,
            spawn_diffs: None,
            found: HashMap::default(),
            probe,
            pool,
            heap: BinaryHeap::new(),
            seq: 0,
            blobs: HashMap::default(),
            rename_blobs: None,
            rename_limit: None,
            fake: None,
            finals: Vec::new(),
            profile: Profile::default(),
            bloom: None,
            bloom_keys: Vec::new(),
        }
    }

    fn intern(&mut self, path: &[u8]) -> usize {
        if let Some(id) = self.path_ids.get(path) {
            return *id;
        }
        let id = self.paths.len();
        self.paths.push(path.to_vec());
        self.attributes_checked.push(false);
        let components = path
            .split(|b| *b == b'/')
            .map(|name| {
                let next = self.name_ids.len() as u32;
                (*self.name_ids.entry(name.to_vec()).or_insert(next), name.to_vec())
            })
            .collect();
        self.components.push(Arc::new(components));
        self.path_ids.insert(path.to_vec(), id);
        self.batch.push(FIRST_BATCH);
        self.frontier.push(Vec::new());
        id
    }

    /// 提交的日期、根树与父提交：在 commit-graph 里的直接取，不在的解码对象。
    fn node(&mut self, id: ObjectId) -> Result<usize, Fallback> {
        if let Some(index) = self.by_id.get(&id) {
            return Ok(*index);
        }
        let position = self.graph.as_ref().and_then(|graph| graph.lookup(id));
        self.node_at(id, position)
    }

    /// 第 `index` 个父提交；父提交在 commit-graph 里的位置已知时不用再按对象名查
    fn parent_node(&mut self, commit: usize, index: usize) -> Result<usize, Fallback> {
        let id = self.commits[commit].parent_ids[index];
        if let Some(found) = self.by_id.get(&id) {
            return Ok(*found);
        }
        match self.commits[commit].parent_positions.get(index).copied() {
            Some(position) => self.node_at(id, Some(position)),
            None => self.node(id),
        }
    }

    fn node_at(&mut self, id: ObjectId, position: Option<gix::commitgraph::Position>) -> Result<usize, Fallback> {
        let mut parent_positions = Vec::new();
        let (date, tree, parent_ids) = match self.graph.as_ref().zip(position) {
            Some((graph, pos)) => {
                let commit = graph.commit_at(pos);
                let mut parents = Vec::new();
                for parent in commit.iter_parents() {
                    let parent = parent.map_err(|e| e.to_string())?;
                    parent_positions.push(parent);
                    parents.push(graph.id_at(parent).to_owned());
                }
                (commit.committer_timestamp(), commit.root_tree_id().to_owned(), parents)
            }
            None => {
                let object = self.repo.find_object(id).map_err(|e| e.to_string())?;
                if object.kind != gix::object::Kind::Commit {
                    return Err(format!("{id} 不是提交"));
                }
                let data = &object.data;
                let parsed = crate::history::log_format::parse_commit(data, self.hexsz)?;
                let tree = data
                    .get(5..5 + self.hexsz)
                    .ok_or("bogus commit object")
                    .and_then(|hex| ObjectId::from_hex(hex).map_err(|_| "bogus commit object"))?;
                (parsed.date, tree, parsed.parents)
            }
        };
        let index = self.commits.len();
        self.commits.push(Commit {
            id,
            date,
            tree,
            parent_ids,
            parent_positions,
            parents: None,
            maybe: None,
            origins: Vec::new(),
            boundary: false,
        });
        self.by_id.insert(id, index);
        Ok(index)
    }

    fn parents(&mut self, commit: usize) -> Result<Vec<usize>, Fallback> {
        if let Some(parents) = &self.commits[commit].parents {
            return Ok(parents.clone());
        }
        let count = self.commits[commit].parent_ids.len();
        let mut parents = Vec::with_capacity(count);
        for index in 0..count {
            parents.push(self.parent_node(commit, index)?);
        }
        self.commits[commit].parents = Some(parents.clone());
        Ok(parents)
    }

    /// blame.c `get_origin`：找到就移到链表头，没有就新建（`make_origin` 插在链表头）。
    fn get_origin(&mut self, commit: usize, path: usize) -> Result<usize, Fallback> {
        let list = &mut self.commits[commit].origins;
        if let Some(pos) = list.iter().position(|&o| self.origins[o].path == path) {
            let origin = list.remove(pos);
            list.insert(0, origin);
            return Ok(origin);
        }
        // 每个读内容的路径都要过属性检查：blob 只有 textconv 会改变 git 读到的内容。
        // 属性只取决于路径（工作区与索引里的 .gitattributes），每个路径查一次
        if !self.attributes_checked[path] {
            let name = self.paths[path].clone();
            if let Some((name, _)) = (self.attributes)(name.as_bstr())?
                .into_iter()
                .find(|(name, state)| name == "diff" && matches!(state, gix::attrs::State::Value(_)))
            {
                return Err(format!("属性 {name}"));
            }
            self.attributes_checked[path] = true;
        }
        let origin = self.origins.len();
        self.origins.push(Origin {
            commit,
            path,
            blob: ObjectId::null(self.repo.object_hash()),
            mode: 0,
            previous: None,
            suspects: Vec::new(),
        });
        self.commits[commit].origins.insert(0, origin);
        Ok(origin)
    }

    fn push(&mut self, commit: usize) {
        self.heap.push((self.commits[commit].date, Reverse(self.seq), commit));
        self.seq += 1;
    }

    /// `setup_scoreboard`（有修订号）：最终文件是这个提交里这个路径的 blob。
    fn setup_commit(&mut self, revision: &str, path: usize) -> Result<(usize, Vec<u8>), Fallback> {
        let id = if revision == "HEAD" {
            self.repo.head_id().map_err(|e| e.to_string())?.detach()
        } else if revision.len() == self.hexsz {
            ObjectId::from_hex(revision.as_bytes()).map_err(|e| e.to_string())?
        } else {
            return Err("不是完整的对象名".into());
        };
        let commit = self.node(id)?;
        let found = self.lookup(commit, path)?;
        let Found::Leaf { mode, id: blob } = found else { return Err("路径不是文件".into()) };
        if !matches!(mode & 0o170000, 0o100000 | 0o120000) {
            return Err("路径是子模块".into());
        }
        let origin = self.get_origin(commit, path)?;
        self.origins[origin].blob = blob;
        self.origins[origin].mode = mode;
        let data = self.read_blob(blob)?;
        Ok((origin, data.as_ref().clone()))
    }

    /// blame.c `fake_working_tree_commit`：父提交是 HEAD，合并中再按 `append_merge_parents` 接上
    /// MERGE_HEAD 里的每个提交（不是完整对象名或不是提交时 git 报错，交给它）；
    /// 内容是工作区文件（符号链接是链接目标；没有转换：属性和 `core.autocrlf` 已检查过），
    /// 模式是 lstat 得到的 `canon_mode`。索引里换上这个条目后 `do_diff_cache` 只比这一个路径。
    fn setup_worktree(&mut self, root: &Path, file: &str) -> Result<(usize, Vec<u8>), Fallback> {
        let head = self.repo.head_id().map_err(|e| e.to_string())?.detach();
        let head_commit = self.node(head)?;
        let mut parent_ids = vec![head];
        match std::fs::read(self.repo.git_dir().join("MERGE_HEAD")) {
            Ok(merge_head) => {
                // 每行一个完整对象名，必须是提交；别的写法 git 会报错，交给它
                for line in merge_head.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
                    if line.len() != self.hexsz {
                        return Err("MERGE_HEAD 里不是完整对象名".into());
                    }
                    let id = ObjectId::from_hex(line).map_err(|e| e.to_string())?;
                    if self.repo.find_header(id).map_err(|e| e.to_string())?.kind() != gix::object::Kind::Commit {
                        return Err("MERGE_HEAD 里不是提交".into());
                    }
                    parent_ids.push(id);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let parents = parent_ids.iter().map(|&id| self.node(id)).collect::<Result<Vec<_>, _>>()?;
        let path = self.intern(file.as_bytes());
        let Found::Leaf { mode: head_mode, .. } = self.lookup(head_commit, path)? else {
            return Err("HEAD 里不是文件".into());
        };
        let index = self.repo.open_index().map_err(|e| e.to_string())?;
        if index.is_sparse() {
            return Err("稀疏索引".into());
        }
        let mut dir_prefix = file.as_bytes().to_vec();
        dir_prefix.push(b'/');
        if index.prefixed_entries(dir_prefix.as_bstr()).is_some_and(|entries| !entries.is_empty()) {
            return Err("索引里有同名目录".into());
        }
        // lstat(path)：上级目录是符号链接时交给 git
        let mut dir = root.to_path_buf();
        let parts: Vec<&str> = file.split('/').collect();
        for part in &parts[..parts.len() - 1] {
            dir.push(part);
            match std::fs::symlink_metadata(&dir) {
                Ok(metadata) if metadata.file_type().is_dir() => {}
                _ => return Err("上级目录不是普通目录".into()),
            }
        }
        let full = root.join(file);
        let metadata = std::fs::symlink_metadata(&full).map_err(|e| e.to_string())?;
        if metadata.len() > MAX_FILE_SIZE {
            return Err("文件太大".into());
        }
        let (mode, content) = if metadata.file_type().is_symlink() {
            use std::os::unix::ffi::OsStrExt;
            (0o120000, std::fs::read_link(&full).map_err(|e| e.to_string())?.as_os_str().as_bytes().to_vec())
        } else if metadata.file_type().is_file() {
            use std::os::unix::fs::PermissionsExt;
            let content = std::fs::read(&full).map_err(|e| e.to_string())?;
            if content.len() as u64 != metadata.len() {
                return Err("读取时文件在变".into());
            }
            (if metadata.permissions().mode() & 0o100 != 0 { 0o100755 } else { 0o100644 }, content)
        } else {
            return Err("工作区里不是文件".into());
        };
        // 类型和 HEAD 不同时 find_origin 找不到，git 会对索引做重命名检测
        if mode & 0o170000 != head_mode & 0o170000 {
            return Err("工作区与 HEAD 类型不同".into());
        }
        self.check_worktree_conversion(file, &content)?;
        let hash = self.repo.object_hash();
        let blob = gix::objs::compute_hash(hash, gix::objs::Kind::Blob, &content).map_err(|e| e.to_string())?;

        let now =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
        let offset = chrono::Local::now().offset().local_minus_utc() / 60;
        let (sign, offset) = if offset < 0 { ('-', -offset) } else { ('+', offset) };
        let ident = format!("Not Committed Yet <not.committed.yet> {now} {sign}{:02}{:02}", offset / 60, offset % 60);
        let mut buffer = format!("tree {}\n", ObjectId::null(hash)).into_bytes();
        for parent in &parent_ids {
            buffer.extend_from_slice(format!("parent {parent}\n").as_bytes());
        }
        buffer.extend_from_slice(format!("author {ident}\ncommitter {ident}\n\nVersion of ").as_bytes());
        buffer.extend_from_slice(file.as_bytes());
        buffer.extend_from_slice(b" from ");
        buffer.extend_from_slice(file.as_bytes());
        buffer.push(b'\n');

        let commit = self.commits.len();
        let null = ObjectId::null(hash);
        self.commits.push(Commit {
            id: null,
            date: now,
            tree: null,
            parent_ids,
            parent_positions: Vec::new(),
            parents: Some(parents),
            maybe: None,
            origins: Vec::new(),
            boundary: false,
        });
        let origin = self.get_origin(commit, path)?;
        self.origins[origin].blob = blob;
        self.origins[origin].mode = mode;
        let content = Arc::new(content);
        self.fake = Some(Fake { commit, content: content.clone(), blob, buffer });
        Ok((origin, content.as_ref().clone()))
    }

    /// `convert_to_git(…, conv_flags = 0)` 对这份工作区内容是不是原样：filter、ident、
    /// working-tree-encoding 让位；行尾转换（`text`/`eol`/`crlf` 属性或 `core.autocrlf`）只会把 CRLF
    /// 改成 LF（convert.c `crlf_to_git` 没有 CRLF 时什么也不做），`-text` 时不转换。
    fn check_worktree_conversion(&mut self, file: &str, content: &[u8]) -> Result<(), Fallback> {
        use gix::attrs::State;
        let attributes = (self.attributes)(BStr::new(file))?;
        let mut eol_conversion = self.settings.autocrlf;
        let mut binary = false;
        for (name, state) in &attributes {
            match (name.as_str(), state) {
                ("filter" | "working-tree-encoding", State::Value(_) | State::Set) | ("ident", State::Set) => {
                    return Err(format!("属性 {name}"));
                }
                ("text", State::Unset) => binary = true,
                ("text" | "eol" | "crlf", State::Set | State::Value(_)) => eol_conversion = true,
                _ => {}
            }
        }
        if eol_conversion && !binary && content.windows(2).any(|pair| pair == b"\r\n") {
            return Err("工作区内容可能做行尾转换".into());
        }
        Ok(())
    }

    fn is_fake(&self, commit: usize) -> bool {
        self.fake.as_ref().is_some_and(|fake| fake.commit == commit)
    }

    /// 这个提交里这个路径是什么。没查过时从它起沿第一父链预取一批（批量翻倍）；查完后，
    /// 批里第一父提交内容不同的合并提交 `pass_blame` 一定会接着查其余父提交，
    /// 就把那些父链也接着预取，直到凑满一批；批次满了还没走的支链起点（和走到一半的链）
    /// 记在 `frontier` 里，下一批先走它们——短分支合并为主的历史里，主线一批就满，
    /// 不接着走的话每条支链都要等主线程走到它才单独查一小批，diff 刚发现就要用，并行不起来。
    /// 预取只填缓存（`found`、先算的 diff），什么时候查、查了哪些都不改变结果。
    /// 先算的 diff 交给另一组线程：diff 只取决于两份内容，与待定行无关，
    /// 提前算的和到时候再算完全一样；读不了或太大的不放进缓存，到时候照常走 `read_blob` 让位。
    fn lookup(&mut self, commit: usize, path: usize) -> Result<Found, Fallback> {
        if let Some(found) = self.found.get(&(commit, path)) {
            return Ok(*found);
        }
        let size = self.batch[path];
        self.batch[path] = (size * 2).min(MAX_BATCH);
        let mut starts = vec![commit];
        // 上次批次满了没走的合并支链接着走：它们多半马上就要用到
        let frontier = std::mem::take(&mut self.frontier[path]);
        starts
            .extend(frontier.into_iter().filter(|&start| start != commit && !self.found.contains_key(&(start, path))));
        self.profile.carried += starts.len() - 1;
        let mut leftover = Vec::new();
        let mut total = 0;
        // 查完这一批后一起并行算的 diff
        let mut pairs = Vec::new();
        while !starts.is_empty() && total < size {
            // (提交, 树, 第几条链)
            let mut batch: Vec<(usize, ObjectId, usize)> = Vec::new();
            let mut queued = HashSet::default();
            for (chain, start) in std::mem::take(&mut starts).into_iter().enumerate() {
                if total + batch.len() >= size {
                    leftover.push(start);
                    continue;
                }
                let mut next = Some(start);
                // 有过滤器时只查会比较到的提交：过滤器说可能变了的提交和它的第一父提交
                let mut needed = true;
                let mut walked = 0;
                while let Some(current) = next {
                    if total + batch.len() >= size
                        || walked >= WALK_LIMIT
                        || self.found.contains_key(&(current, path))
                        || self.is_fake(current)
                        || !queued.insert(current)
                    {
                        // 批次满了停下的链下次接着走
                        if walked > 0 && total + batch.len() >= size && !self.found.contains_key(&(current, path)) {
                            leftover.push(current);
                        }
                        break;
                    }
                    walked += 1;
                    let maybe = self.bloom.is_none() || self.maybe_changed(current)?;
                    if needed || maybe {
                        batch.push((current, self.commits[current].tree, chain));
                    }
                    needed = maybe;
                    next = match self.commits[current].parent_ids.is_empty() {
                        false => Some(self.parent_node(current, 0)?),
                        true => None,
                    };
                }
            }
            if batch.is_empty() {
                break;
            }
            total += batch.len();
            let commits: Vec<usize> = batch.iter().map(|item| item.0).collect();
            let timer = Instant::now();
            self.lookup_batch(batch, path);
            self.profile.lookup += timer.elapsed();
            // 第一父提交里不是同一个 blob 的合并提交：其余父提交也会被查
            for &current in &commits {
                if self.commits[current].parent_ids.len() < 2 {
                    continue;
                }
                let Some(Found::Leaf { id, .. }) = self.found.get(&(current, path)).copied() else { continue };
                let first = self.parent_node(current, 0)?;
                match self.found.get(&(first, path)) {
                    Some(Found::Leaf { id: parent_blob, .. }) if *parent_blob == id => continue,
                    None => continue,
                    _ => {}
                }
                for index in 1..self.commits[current].parent_ids.len() {
                    let parent = self.parent_node(current, index)?;
                    if !self.found.contains_key(&(parent, path)) {
                        starts.push(parent);
                    }
                }
            }
            for &current in &commits {
                self.diff_ready(current, path, &mut pairs);
            }
            for &current in &commits {
                if let Some(children) = self.waiters.remove(&(self.commits[current].id, path)) {
                    for child in children {
                        self.diff_ready(child, path, &mut pairs);
                    }
                }
            }
        }
        leftover.append(&mut starts);
        self.frontier[path] = leftover;
        let timer = Instant::now();
        self.diff_all(pairs);
        self.profile.diff += timer.elapsed();
        match self.found.get(&(commit, path)) {
            Some(found) => Ok(*found),
            None => {
                let timer = Instant::now();
                let found = self.probe.lookup(self.commits[commit].tree, &self.components[path]);
                self.profile.lookup += timer.elapsed();
                found
            }
        }
    }

    /// 父提交都查到了的提交：`pass_blame` 会对哪些父提交做 diff 就先算好。
    /// 有父提交是同一个 blob 时整体让给它，不做 diff；否则对每个有这个路径的父提交各做一次。
    /// 还有父提交没查到的记在那个父提交名下，等它查到了再看（`waiters`）。
    fn diff_ready(&mut self, commit: usize, path: usize, pairs: &mut Vec<(ObjectId, ObjectId)>) {
        let Some(Found::Leaf { id: child, .. }) = self.found.get(&(commit, path)).copied() else { return };
        let mut blobs = Vec::new();
        for parent_id in &self.commits[commit].parent_ids {
            let found = self.by_id.get(parent_id).and_then(|parent| self.found.get(&(*parent, path)));
            match found {
                Some(Found::Leaf { id, .. }) if *id == child => return,
                Some(Found::Leaf { id, .. }) => blobs.push(*id),
                Some(_) => {}
                None => {
                    self.waiters.entry((*parent_id, path)).or_default().push(commit);
                    return;
                }
            }
        }
        pairs.extend(blobs.into_iter().map(|base| (base, child)));
    }

    /// 发给先算 diff 的线程，不等结果（单线程时不先算，用到时现算）
    fn diff_all(&mut self, mut pairs: Vec<(ObjectId, ObjectId)>) {
        let mut seen = HashSet::default();
        pairs.retain(|pair| seen.insert(*pair) && !self.pending.contains(pair) && !self.hunks.contains_key(pair));
        if pairs.is_empty() {
            return;
        }
        if self.diffs.is_none() {
            let Some(spawn) = self.spawn_diffs.take() else { return };
            self.diffs = Some(spawn());
        }
        let diffs = self.diffs.as_ref().expect("diff pool started above");
        for chunk in pairs.chunks(DIFF_CHUNK) {
            diffs.jobs.send(chunk.to_vec()).expect("blame diff worker gone");
        }
        self.pending.extend(pairs);
    }

    /// 收先算好的 diff；`wait` 时一直收到这一对为止
    fn collect_diffs(&mut self, wait: Option<(ObjectId, ObjectId)>) {
        let Some(diffs) = &self.diffs else { return };
        loop {
            let part = match wait {
                Some(pair) if self.pending.contains(&pair) => diffs.results.recv().expect("blame diff worker gone"),
                _ => match diffs.results.try_recv() {
                    Ok(part) => part,
                    Err(_) => return,
                },
            };
            for (pair, diffed) in part {
                self.pending.remove(&pair);
                if let Diffed::Hunks(hunks) = diffed {
                    self.hunks.insert(pair, hunks);
                    self.profile.diffs_ahead += 1;
                }
            }
        }
    }

    /// 一批 (提交, 树, 链号)。多线程时按小段交错分给线程；某条链上查到路径不存在后，
    /// 链上更早的祖先多半用不到，各线程跳过它们（只是预取，用到时再单独查）。
    fn lookup_batch(&mut self, batch: Vec<(usize, ObjectId, usize)>, path: usize) {
        use std::sync::atomic::AtomicUsize;
        let components = self.components[path].clone();
        let step = if batch.len() < PARALLEL_MIN { 1 } else { self.pool.jobs.len() + 1 };
        let chains = batch.last().map_or(0, |item| item.2 + 1);
        let stops: Arc<Vec<AtomicUsize>> = Arc::new((0..chains).map(|_| AtomicUsize::new(usize::MAX)).collect());
        let batch = Arc::new(batch);
        for (first, jobs) in self.pool.jobs.iter().enumerate().take(step - 1) {
            let job = Job {
                batch: batch.clone(),
                components: components.clone(),
                stops: stops.clone(),
                first: first + 1,
                step,
            };
            jobs.send(job).expect("blame worker gone");
        }
        let mut results = lookup_share(&mut self.probe, &batch, &components, &stops, 0, step);
        for _ in 1..step {
            results.extend(self.pool.replies.recv().expect("blame worker gone"));
        }
        for (index, result) in results {
            // 出错的提交只有真正用到时才让位
            if let Ok(found) = result {
                self.found.insert((batch[index].0, path), found);
            }
        }
    }

    fn read_blob(&mut self, id: ObjectId) -> Result<Arc<Vec<u8>>, Fallback> {
        if let Some(fake) = &self.fake
            && fake.blob == id
        {
            return Ok(fake.content.clone());
        }
        if let Some(data) = self.blobs.get(&id) {
            return Ok(data.clone());
        }
        let data = self.probe.blob(id)?;
        self.blobs.insert(id, data.clone());
        Ok(data)
    }

    /// `queue_blames`：并入父 origin 的待定行；这个提交名下原本没有待定行时入队。
    fn queue_blames(&mut self, origin: usize, mut entries: Vec<Entry>) {
        if entries.is_empty() {
            return;
        }
        let commit = self.origins[origin].commit;
        let idle = self.commits[commit].origins.iter().all(|&o| self.origins[o].suspects.is_empty());
        let suspects = &mut self.origins[origin].suspects;
        if suspects.is_empty() {
            *suspects = entries;
        } else {
            suspects.append(&mut entries);
            suspects.sort_by_key(|entry| entry.s_lno);
        }
        if idle {
            self.push(commit);
        }
    }

    /// `assign_blame`
    fn assign(&mut self) -> Result<(), Fallback> {
        while let Some((_, _, commit)) = self.heap.pop() {
            while let Some(origin) =
                self.commits[commit].origins.iter().copied().find(|&o| !self.origins[o].suspects.is_empty())
            {
                self.pass_blame(origin)?;
                if self.commits[commit].parent_ids.is_empty() && !self.settings.show_root {
                    self.commits[commit].boundary = true;
                }
                let remaining = std::mem::take(&mut self.origins[origin].suspects);
                self.finals.extend(remaining.into_iter().map(|entry| (origin, entry)));
            }
        }
        Ok(())
    }

    /// `pass_blame`
    fn pass_blame(&mut self, origin: usize) -> Result<(), Fallback> {
        self.profile.passes += 1;
        let commit = self.origins[origin].commit;
        let parents = self.parents(commit)?;
        if parents.is_empty() {
            return Ok(());
        }
        let mut scapegoats: Vec<Option<usize>> = vec![None; parents.len()];
        for pass in 0..2 {
            for (i, &parent) in parents.iter().enumerate() {
                if scapegoats[i].is_some() {
                    continue;
                }
                let found = if pass == 0 {
                    self.find_origin(parent, origin)?
                } else {
                    let timer = Instant::now();
                    let found = self.find_rename(parent, origin)?;
                    self.profile.rename += timer.elapsed();
                    found
                };
                let Some(porigin) = found else { continue };
                if self.origins[porigin].blob == self.origins[origin].blob {
                    // pass_whole_blame
                    let suspects = std::mem::take(&mut self.origins[origin].suspects);
                    self.queue_blames(porigin, suspects);
                    return Ok(());
                }
                let blob = self.origins[porigin].blob;
                if scapegoats[..i].iter().flatten().any(|&o| self.origins[o].blob == blob) {
                    continue;
                }
                scapegoats[i] = Some(porigin);
            }
        }
        for porigin in scapegoats.into_iter().flatten() {
            if self.origins[origin].previous.is_none() {
                self.origins[origin].previous = Some(porigin);
            }
            self.pass_blame_to_parent(origin, porigin)?;
            if self.origins[origin].suspects.is_empty() {
                break;
            }
        }
        // drop_origin_blob：这个版本处理完了；父提交的版本马上要当子版本用，留着
        let blob = self.origins[origin].blob;
        self.blobs.remove(&blob);
        Ok(())
    }

    /// blame.c `maybe_changed_path`：这个提交（对第一父提交）可能改了某个键的路径。
    /// 键只增不减：用较少的键算出「可能变了」的结果仍然成立。
    fn maybe_changed(&mut self, commit: usize) -> Result<bool, Fallback> {
        let Some(bloom) = &self.bloom else { return Ok(true) };
        let keys = self.bloom_keys.len();
        if let Some((counted, maybe)) = self.commits[commit].maybe
            && (counted == keys || maybe)
        {
            return Ok(maybe);
        }
        let maybe = bloom.maybe_changed(&self.commits[commit].id, &self.bloom_keys)?;
        self.commits[commit].maybe = Some((keys, maybe));
        Ok(maybe)
    }

    /// `find_origin`：父提交里同一路径。比较的是两棵树里这个路径的条目（`diff_tree_oid`）；
    /// 工作区「提交」比的是换上了工作区内容的索引条目（`do_diff_cache`）。第一父提交的过滤器说
    /// 没变时 git 不比较，直接沿用子版本的 blob——过滤器假阴性时这个 blob 和父提交树里的不同，
    /// 之后的比较仍按真实的树来，照样一致。
    fn find_origin(&mut self, parent: usize, origin: usize) -> Result<Option<usize>, Fallback> {
        let path = self.origins[origin].path;
        if let Some(&existing) = self.commits[parent].origins.iter().find(|&&o| self.origins[o].path == path) {
            return Ok(Some(existing));
        }
        let commit = self.origins[origin].commit;
        let (mode, blob) = (self.origins[origin].mode, self.origins[origin].blob);
        let child = if self.is_fake(commit) {
            Found::Leaf { mode, id: blob }
        } else {
            if self.commits[commit].parent_ids.first() == Some(&self.commits[parent].id)
                && !self.maybe_changed(commit)?
            {
                return self.same_origin(parent, path, mode, blob).map(Some);
            }
            self.lookup(commit, path)?
        };
        let (pmode, pblob) = match (child, self.lookup(parent, path)?) {
            (Found::Tree, _) | (_, Found::Tree) => return Err("路径在其中一个提交里是目录".into()),
            (child, found) if child == found => return self.same_origin(parent, path, mode, blob).map(Some),
            // 只在过滤器假阴性之后出现：git 在这里报内部错误
            (Found::Missing, _) => return Err("子提交里没有这个路径".into()),
            (_, Found::Missing) => return Ok(None),
            // 类型变了（普通文件、符号链接、子模块之间）：DIFF_STATUS_TYPE_CHANGED
            (Found::Leaf { mode: cmode, .. }, Found::Leaf { mode: pmode, .. })
                if pmode & 0o170000 != cmode & 0o170000 =>
            {
                return Ok(None);
            }
            (_, Found::Leaf { mode: pmode, id }) => (pmode, id),
        };
        let porigin = self.get_origin(parent, path)?;
        self.origins[porigin].blob = pblob;
        self.origins[porigin].mode = pmode;
        Ok(Some(porigin))
    }

    /// 没有差异：父提交的 origin 沿用子版本的 blob 与模式。
    fn same_origin(&mut self, parent: usize, path: usize, mode: u32, blob: ObjectId) -> Result<usize, Fallback> {
        let porigin = self.get_origin(parent, path)?;
        self.origins[porigin].blob = blob;
        self.origins[porigin].mode = mode;
        Ok(porigin)
    }

    /// `find_rename`：父子两棵树整体做重命名检测，只认这个路径作目标。
    fn find_rename(&mut self, parent: usize, origin: usize) -> Result<Option<usize>, Fallback> {
        let commit = self.origins[origin].commit;
        if self.is_fake(commit) {
            return Err("对索引做重命名检测".into());
        }
        let target = self.paths[self.origins[origin].path].clone();
        let queue =
            crate::rename::tree_queue(self.repo, Some(self.commits[parent].tree), self.commits[commit].tree, true)?;
        let queue: Vec<Change> = queue
            .into_iter()
            .filter(|change| {
                change.two.is_none() || (change.one.is_none() && change.path.as_slice() == target.as_slice())
            })
            .collect();
        let Some(dst) = queue.iter().position(|change| change.one.is_none()) else { return Ok(None) };
        if queue.len() == 1 {
            return Ok(None);
        }
        let limit = match self.rename_limit {
            Some(limit) => limit,
            None => {
                let limit = crate::rename::check_rename_settings(self.repo)?;
                self.rename_limit = Some(limit);
                limit
            }
        };
        if self.rename_blobs.is_none() {
            // diffcore-delta 的 spanhash 只受「是不是二进制」影响：diff 属性（含 binary 宏）决定 driver，
            // 其余由内容判断；树里的 blob 不做行尾转换
            let mut list = rd::attribute_lister(self.repo)?;
            let check: crate::rename::AttributeCheck<'r> = Box::new(move |path: &BStr| {
                match list(path)?.into_iter().find(|(name, _)| name == "diff" || name == "binary") {
                    Some((name, _)) => Err(format!("属性 {name}")),
                    None => Ok(()),
                }
            });
            self.rename_blobs = Some(RepoBlobs::with_attributes(self.repo, check));
        }
        let blobs = self.rename_blobs.as_mut().expect("刚建好");
        let renames = crate::rename::detect_renames(&queue, blobs, limit)?;
        let Some((source, _)) = renames[dst] else { return Ok(None) };
        let Some(Side { mode, id }) = queue[source].one else { return Ok(None) };
        // add_bloom_key：之后每次过滤器检查都带上这个来源路径
        if let Some(bloom) = &self.bloom {
            self.bloom_keys.push(bloom.key(queue[source].path.as_slice()));
        }
        let source_path = self.intern(queue[source].path.as_slice());
        let porigin = self.get_origin(parent, source_path)?;
        self.origins[porigin].blob = id;
        self.origins[porigin].mode = mode;
        Ok(Some(porigin))
    }

    /// `pass_blame_to_parent`：父 → 子的 diff，改动块外的行交给父提交（`blame_chunk` 的逐行语义）。
    fn pass_blame_to_parent(&mut self, target: usize, parent: usize) -> Result<(), Fallback> {
        let key = (self.origins[parent].blob, self.origins[target].blob);
        // 预取时已经算好的直接用（同样两份内容的 diff）；已经有线程在算的等它算完，
        // 还没有线程开始的由本线程认领、下面现算
        if self.pending.contains(&key) {
            let timer = Instant::now();
            self.collect_diffs(None);
            let diffs = self.diffs.as_ref().expect("pending diffs have a pool");
            if self.pending.contains(&key) && diffs.claimed.lock().is_ok_and(|mut claimed| claimed.insert(key)) {
                self.pending.remove(&key);
            } else {
                self.collect_diffs(Some(key));
            }
            self.profile.diff += timer.elapsed();
        }
        let hunks = match self.hunks.remove(&key) {
            Some(hunks) => hunks,
            None => {
                let timer = Instant::now();
                let file_p = self.read_blob(self.origins[parent].blob)?;
                let file_o = self.read_blob(self.origins[target].blob)?;
                let hunks = crate::xdiff::blame_hunks(&file_p, &file_o);
                self.profile.diffs_inline += 1;
                self.profile.diff_inline += timer.elapsed();
                hunks
            }
        };
        let suspects = std::mem::take(&mut self.origins[target].suspects);
        let mut passed = Vec::new();
        let mut kept = Vec::new();
        let tail_offset = hunks.last().map_or(0, |h| (h[0] + h[1]) as isize - (h[2] + h[3]) as isize);
        for entry in suspects {
            let end = entry.s_lno + entry.num;
            let mut pos = entry.s_lno;
            let mut k = hunks.partition_point(|h| h[2] + h[3] <= pos);
            while pos < end {
                let piece = |pos: usize, len: usize, s_lno: usize| Entry {
                    lno: entry.lno + (pos - entry.s_lno),
                    s_lno,
                    num: len,
                };
                match hunks.get(k) {
                    Some(h) if pos < h[2] => {
                        let len = end.min(h[2]) - pos;
                        let offset = h[0] as isize - h[2] as isize;
                        passed.push(piece(pos, len, (pos as isize + offset) as usize));
                        pos += len;
                    }
                    Some(h) => {
                        let len = end.min(h[2] + h[3]) - pos;
                        if len > 0 {
                            kept.push(piece(pos, len, pos));
                            pos += len;
                        }
                        k += 1;
                    }
                    None => {
                        passed.push(piece(pos, end - pos, (pos as isize + tail_offset) as usize));
                        pos = end;
                    }
                }
            }
        }
        self.origins[target].suspects = kept;
        passed.sort_by_key(|entry| entry.s_lno);
        self.queue_blames(parent, passed);
        Ok(())
    }

    /// builtin/blame.c `output`（porcelain）：按最终行号排序、合并相邻的连续段后逐段输出。
    fn output(&mut self, final_buf: &[u8], lines: &[usize]) -> Result<Vec<u8>, Fallback> {
        let mut finals = std::mem::take(&mut self.finals);
        finals.sort_by_key(|(_, entry)| entry.lno);
        // blame_coalesce
        let mut merged: Vec<(usize, Entry)> = Vec::with_capacity(finals.len());
        for (origin, entry) in finals {
            if let Some((last_origin, last)) = merged.last_mut()
                && *last_origin == origin
                && last.s_lno + last.num == entry.s_lno
                && last.lno + last.num == entry.lno
            {
                last.num += entry.num;
                continue;
            }
            merged.push((origin, entry));
        }
        // MORE_THAN_ONE_PATH：同一提交有不止一个路径负责行
        let mut paths_of: HashMap<usize, HashSet<usize>> = HashMap::default();
        for (origin, _) in &merged {
            paths_of.entry(self.origins[*origin].commit).or_default().insert(self.origins[*origin].path);
        }
        let mut shown = HashSet::default();
        let mut out = Vec::with_capacity(final_buf.len() * 2 + merged.len() * 64);
        for (origin, entry) in merged {
            let commit = self.origins[origin].commit;
            let hex = self.commits[commit].id.to_hex().to_string();
            out.extend_from_slice(format!("{hex} {} {} {}\n", entry.s_lno + 1, entry.lno + 1, entry.num).as_bytes());
            let first = shown.insert(commit);
            if first {
                self.emit_details(commit, &mut out)?;
            }
            if first || paths_of[&commit].len() > 1 {
                if let Some(previous) = self.origins[origin].previous {
                    let previous = &self.origins[previous];
                    out.extend_from_slice(format!("previous {} ", self.commits[previous.commit].id).as_bytes());
                    out.extend_from_slice(&rd::quote_two("", &self.paths[previous.path], self.settings.quote_fully));
                    out.push(b'\n');
                }
                out.extend_from_slice(b"filename ");
                out.extend_from_slice(&rd::quote_two(
                    "",
                    &self.paths[self.origins[origin].path],
                    self.settings.quote_fully,
                ));
                out.push(b'\n');
            }
            for k in 0..entry.num {
                if k > 0 {
                    out.extend_from_slice(format!("{hex} {} {}\n", entry.s_lno + 1 + k, entry.lno + 1 + k).as_bytes());
                }
                out.push(b'\t');
                let line = entry.lno + k;
                out.extend_from_slice(&final_buf[lines[line]..lines[line + 1]]);
            }
            if !final_buf.is_empty() && out.last() != Some(&b'\n') {
                out.push(b'\n');
            }
        }
        Ok(out)
    }

    /// `emit_one_suspect_detail`
    fn emit_details(&self, commit: usize, out: &mut Vec<u8>) -> Result<(), Fallback> {
        let id = self.commits[commit].id;
        let owned;
        let buffer: &[u8] = match &self.fake {
            Some(fake) if fake.commit == commit => &fake.buffer,
            _ => {
                let object = self.repo.find_object(id).map_err(|e| e.to_string())?;
                owned = object.detach().data;
                &owned
            }
        };
        if buffer.contains(&0) {
            return Err("提交里有 NUL".into());
        }
        if !self.is_fake(commit) {
            let parsed = crate::history::log_format::parse_commit(buffer, self.hexsz)?;
            if parsed.has_encoding_header && !utf8_encoding_header(buffer) {
                return Err("提交带非 UTF-8 编码".into());
            }
        }
        let author = ac_line(buffer, b"\nauthor ")?;
        let committer = ac_line(buffer, b"\ncommitter ")?;
        for (prefix, ident) in [("author", &author), ("committer", &committer)] {
            out.extend_from_slice(prefix.as_bytes());
            out.push(b' ');
            out.extend_from_slice(&ident.name);
            out.extend_from_slice(format!("\n{prefix}-mail ").as_bytes());
            out.extend_from_slice(&ident.mail);
            out.extend_from_slice(format!("\n{prefix}-time {}\n{prefix}-tz ", ident.time).as_bytes());
            out.extend_from_slice(&ident.tz);
            out.push(b'\n');
        }
        out.extend_from_slice(b"summary ");
        let subject = commit_subject(buffer);
        if subject.is_empty() {
            out.extend_from_slice(format!("({id})").as_bytes());
        } else {
            out.extend_from_slice(subject);
        }
        out.push(b'\n');
        if self.commits[commit].boundary {
            out.extend_from_slice(b"boundary\n");
        }
        Ok(())
    }
}

/// `encoding` 头部写的是 UTF-8（logmsg_reencode 的 `same_encoding`，不转换）。
fn utf8_encoding_header(buffer: &[u8]) -> bool {
    let header_end = buffer.find(b"\n\n").unwrap_or(buffer.len());
    buffer[..header_end]
        .lines()
        .filter_map(|line| line.strip_prefix(b"encoding "))
        .all(|name| name.to_str().is_ok_and(crate::history::log_format::is_utf8_name))
}

struct Ident {
    name: Vec<u8>,
    mail: Vec<u8>,
    time: u64,
    tz: Vec<u8>,
}

/// git `isspace`（只有 `\t` `\n` `\r` 和空格）
fn is_space(c: u8) -> bool {
    matches!(c, b'\t' | b'\n' | b'\r' | b' ')
}

/// builtin/blame.c `get_ac_line` + ident.c `split_ident_line`（没有 mailmap）。
fn ac_line(buffer: &[u8], what: &[u8]) -> Result<Ident, Fallback> {
    let unknown =
        || Ident { name: b"(unknown)".to_vec(), mail: b"(unknown)".to_vec(), time: 0, tz: b"(unknown)".to_vec() };
    let Some(at) = buffer.find(what) else { return Ok(unknown()) };
    let rest = &buffer[at + what.len()..];
    let line = &rest[..rest.find_byte(b'\n').unwrap_or(rest.len())];
    let Some(lt) = line.find_byte(b'<') else { return Ok(unknown()) };
    let mail_begin = lt + 1;
    let name_end = line[..lt].iter().rposition(|c| !is_space(*c)).map_or(0, |i| i + 1);
    let Some(gt) = line[mail_begin..].find_byte(b'>') else { return Ok(unknown()) };
    let mail_end = mail_begin + gt;
    // 从行尾往回找最后一个 '>'
    let last_gt = line.iter().rposition(|c| *c == b'>').expect("mail_end 处就有一个");
    let mut cp = last_gt + 1;
    while cp < line.len() && is_space(line[cp]) {
        cp += 1;
    }
    let mut date = None;
    let mut tz = None;
    if cp < line.len() {
        let span = line[cp..].iter().take_while(|c| c.is_ascii_digit()).count();
        if span > 0 {
            let date_range = cp..cp + span;
            let mut tp = cp + span;
            while tp < line.len() && is_space(line[tp]) {
                tp += 1;
            }
            if tp < line.len() && matches!(line[tp], b'+' | b'-') {
                let tz_span = line[tp + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
                if tz_span > 0 {
                    date = Some(date_range);
                    tz = Some(tp..tp + 1 + tz_span);
                }
            }
        }
    }
    let time = match date {
        // strtoul：溢出时 git 得到 ULONG_MAX，这种损坏提交交给 git
        Some(range) => line[range].to_str().ok().and_then(|digits| digits.parse::<u64>().ok()).ok_or("时间戳溢出")?,
        None => 0,
    };
    let mut mail = b"<".to_vec();
    mail.extend_from_slice(&line[mail_begin..mail_end]);
    mail.push(b'>');
    Ok(Ident {
        name: line[..name_end].to_vec(),
        mail,
        time,
        tz: tz.map_or_else(|| b"(unknown)".to_vec(), |range| line[range].to_vec()),
    })
}

/// commit.c `find_commit_subject`
fn commit_subject(buffer: &[u8]) -> &[u8] {
    let Some(blank) = buffer.find(b"\n\n") else { return &[] };
    let mut p = blank + 2;
    // pretty.c `skip_blank_lines`
    loop {
        let len = buffer[p..].find_byte(b'\n').map_or(buffer.len() - p, |i| i + 1);
        if len == 0 || buffer[p..p + len].iter().any(|c| !is_space(*c)) {
            break;
        }
        p += len;
    }
    let eol = buffer[p..].find_byte(b'\n').map_or(buffer.len(), |i| p + i);
    &buffer[p..eol]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run(r: &Path, args: &[&str], date: Option<u64>) -> std::process::Output {
        let mut command = Command::new("git");
        command.arg("-C").arg(r).args(args);
        if let Some(at) = date {
            let date = format!("@{at} +0800");
            command.env("GIT_AUTHOR_DATE", &date).env("GIT_COMMITTER_DATE", &date);
        }
        command.output().unwrap()
    }

    fn git(r: &Path, args: &[&str]) -> String {
        let out = run(r, args, None);
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn commit(r: &Path, message: &str, at: &mut u64) {
        *at += 60;
        let out = run(r, &["commit", "-q", "--allow-empty", "-m", message], Some(*at));
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

    fn write(r: &Path, path: &str, content: &[u8]) {
        let full = r.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, content).unwrap();
    }

    fn git_porcelain(r: &Path, revision: Option<&str>, path: &str) -> Vec<u8> {
        let mut args = vec!["blame", "--porcelain"];
        args.extend(revision);
        args.extend(["--", path]);
        let out = run(r, &args, None);
        assert!(out.status.success(), "git blame {path}: {}", String::from_utf8_lossy(&out.stderr));
        out.stdout
    }

    /// 工作区「提交」的时间是现在，两次调用之间可能差一秒：两边都换成占位符再比。
    fn normalize_now(porcelain: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut in_fake = false;
        for line in porcelain.split_inclusive(|b| *b == b'\n') {
            if line.starts_with(b"\t") {
                out.extend_from_slice(line);
                continue;
            }
            if line.len() > 40 && line[..40].iter().all(|b| b.is_ascii_hexdigit()) {
                in_fake = line[..40].iter().all(|b| *b == b'0');
            }
            if in_fake && (line.starts_with(b"author-time ") || line.starts_with(b"committer-time ")) {
                let key = line.split(|b| *b == b' ').next().unwrap();
                out.extend_from_slice(key);
                out.extend_from_slice(b" NOW\n");
                continue;
            }
            out.extend_from_slice(line);
        }
        out
    }

    #[track_caller]
    fn assert_same(r: &Path, revision: Option<&str>, path: &str) {
        let expected = git_porcelain(r, revision, path);
        let ours = porcelain(r, revision, path).unwrap_or_else(|reason| panic!("{path}: refused: {reason}"));
        let (expected, ours) = (normalize_now(&expected), normalize_now(&ours));
        assert!(
            expected == ours,
            "{path} at {revision:?}\n--- git\n{}\n--- ours\n{}",
            String::from_utf8_lossy(&expected),
            String::from_utf8_lossy(&ours)
        );
    }

    /// porcelain 里 `<sha> <原行号> <最终行号> [<行数>]` 那一行
    fn is_group_header(line: &str) -> bool {
        let fields: Vec<&str> = line.split(' ').collect();
        fields.len() >= 3
            && fields[0].len() == 40
            && fields[0].bytes().all(|b| b.is_ascii_hexdigit())
            && fields[1..].iter().all(|f| f.parse::<usize>().is_ok())
    }

    fn numbered(prefix: &str, range: std::ops::Range<usize>) -> String {
        range.map(|i| format!("{prefix} {i}\n")).collect()
    }

    #[test]
    fn 多次修改与根提交边界() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "a.txt", numbered("line", 0..10).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        write(&r, "a.txt", (numbered("line", 0..3) + "changed\n" + &numbered("line", 4..10)).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "second\n\nbody text", &mut at);
        write(&r, "a.txt", (numbered("line", 0..3) + "changed\n" + &numbered("line", 5..10) + "tail\n").as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "  \n  third after blank lines", &mut at);
        assert_same(&r, Some("HEAD"), "a.txt");
        assert_same(&r, None, "a.txt");
        git(&r, &["config", "blame.showRoot", "true"]);
        assert_same(&r, Some("HEAD"), "a.txt");
    }

    #[test]
    fn 工作区改动无末尾换行与crlf() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "w.txt", b"a\r\nb\r\nc\r\n\r\nd");
        git(&r, &["add", "."]);
        commit(&r, "crlf", &mut at);
        assert_same(&r, Some("HEAD"), "w.txt");
        // 工作区与 HEAD 相同：没有一行归到全零提交
        assert_same(&r, None, "w.txt");
        write(&r, "w.txt", b"a\r\nB\r\nc\r\n\r\nd\nnew");
        assert_same(&r, None, "w.txt");
        write(&r, "w.txt", b"");
        assert_same(&r, None, "w.txt");
    }

    #[test]
    fn 含nul与空文件() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "bin.dat", b"\x00\x01\nPNG\x00\nrest\n");
        write(&r, "empty", b"");
        git(&r, &["add", "."]);
        commit(&r, "binary", &mut at);
        write(&r, "bin.dat", b"\x00\x01\nPNG\x00changed\nrest\nmore\x00\n");
        git(&r, &["add", "."]);
        commit(&r, "binary 2", &mut at);
        assert_same(&r, Some("HEAD"), "bin.dat");
        assert_same(&r, Some("HEAD"), "empty");
        assert_same(&r, None, "empty");
    }

    #[test]
    fn 整文件重命名与复制() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "old/name.txt", numbered("x", 0..20).as_bytes());
        write(&r, "other.txt", numbered("o", 0..5).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        std::fs::create_dir_all(r.join("new")).unwrap();
        git(&r, &["mv", "old/name.txt", "new/name.txt"]);
        write(&r, "new/name.txt", (numbered("x", 0..10) + "renamed edit\n" + &numbered("x", 11..20)).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "rename with edit", &mut at);
        // 复制（不删来源）不是重命名：没有 -C 时整份归到复制它的提交
        write(&r, "copy.txt", numbered("x", 0..20).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "copy", &mut at);
        // 两个相同的删除来源：照 diffcore-rename 的选法
        write(&r, "dup1.txt", numbered("d", 0..8).as_bytes());
        write(&r, "dup2.txt", numbered("d", 0..8).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "dups", &mut at);
        git(&r, &["rm", "-q", "dup1.txt", "dup2.txt"]);
        write(&r, "sub/dup2.txt", numbered("d", 0..8).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "move dup", &mut at);
        for path in ["new/name.txt", "copy.txt", "sub/dup2.txt"] {
            assert_same(&r, Some("HEAD"), path);
        }
        write(&r, "new/name.txt", ("worktree first\n".to_string() + &numbered("x", 0..20)).as_bytes());
        assert_same(&r, None, "new/name.txt");
    }

    #[test]
    fn 合并两侧都改与一侧改名() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "f.txt", numbered("base", 0..30).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "base", &mut at);
        git(&r, &["checkout", "-q", "-b", "side"]);
        write(&r, "f.txt", (numbered("base", 0..25) + "side change\n" + &numbered("base", 26..30)).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "side edit", &mut at);
        git(&r, &["checkout", "-q", "main"]);
        write(&r, "f.txt", ("main change\n".to_string() + &numbered("base", 1..30)).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "main edit", &mut at);
        assert!(run(&r, &["merge", "-q", "--no-ff", "side", "-m", "merge side"], Some(at + 60)).status.success());
        at += 60;
        assert_same(&r, Some("HEAD"), "f.txt");

        // 一侧改名：合并后的路径在第二父提交里是旧名
        git(&r, &["checkout", "-q", "-b", "renamer"]);
        git(&r, &["mv", "f.txt", "g.txt"]);
        commit(&r, "rename on branch", &mut at);
        git(&r, &["checkout", "-q", "main"]);
        write(
            &r,
            "f.txt",
            ("main change\n".to_string()
                + &numbered("base", 1..20)
                + "main again\n"
                + &numbered("base", 21..25)
                + "side change\n"
                + &numbered("base", 26..30))
                .as_bytes(),
        );
        git(&r, &["add", "."]);
        commit(&r, "main edit 2", &mut at);
        git(&r, &["checkout", "-q", "renamer"]);
        assert!(
            run(&r, &["merge", "-q", "--no-ff", "main", "-m", "merge main into renamer"], Some(at + 60))
                .status
                .success()
        );
        at += 60;
        assert_same(&r, Some("HEAD"), "g.txt");
        // 第二父提交的 blob 与合并结果相同：整份交给它
        git(&r, &["checkout", "-q", "main"]);
        assert!(run(&r, &["merge", "-q", "--no-ff", "renamer", "-m", "merge back"], Some(at + 60)).status.success());
        assert_same(&r, Some("HEAD"), "g.txt");
        assert_same(&r, None, "g.txt");
    }

    #[test]
    fn 同一提交的两个路径都负责行() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "a.txt", numbered("alpha", 0..10).as_bytes());
        write(&r, "b.txt", numbered("beta", 0..10).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "two files", &mut at);
        git(&r, &["checkout", "-q", "-b", "one"]);
        git(&r, &["rm", "-q", "b.txt"]);
        git(&r, &["mv", "a.txt", "c.txt"]);
        commit(&r, "a to c", &mut at);
        git(&r, &["checkout", "-q", "main"]);
        git(&r, &["rm", "-q", "a.txt"]);
        git(&r, &["mv", "b.txt", "c.txt"]);
        commit(&r, "b to c", &mut at);
        let _ = run(&r, &["merge", "-q", "--no-ff", "one", "-m", "merge"], Some(at + 60));
        write(&r, "c.txt", (numbered("alpha", 0..10) + &numbered("beta", 0..10)).as_bytes());
        git(&r, &["add", "c.txt"]);
        commit(&r, "merge", &mut at);
        let ours = String::from_utf8(porcelain(&r, Some("HEAD"), "c.txt").unwrap()).unwrap();
        assert!(ours.contains("filename a.txt") && ours.contains("filename b.txt"), "{ours}");
        assert_same(&r, Some("HEAD"), "c.txt");
    }

    #[test]
    fn 时钟回拨类型变化与删除后重建() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "t.txt", numbered("t", 0..6).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        write(&r, "t.txt", (numbered("t", 0..3) + "skewed\n" + &numbered("t", 3..6)).as_bytes());
        git(&r, &["add", "."]);
        at -= 3600;
        commit(&r, "older than parent", &mut at);
        at += 7200;
        // 只改可执行位
        git(&r, &["update-index", "--chmod=+x", "t.txt"]);
        commit(&r, "chmod", &mut at);
        git(&r, &["rm", "-q", "-f", "t.txt"]);
        commit(&r, "delete", &mut at);
        write(&r, "t.txt", numbered("t", 0..6).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "recreate", &mut at);
        assert_same(&r, Some("HEAD"), "t.txt");
        // 符号链接换成普通文件：类型变化，父提交里没有对应 origin
        std::os::unix::fs::symlink("t.txt", r.join("link")).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "symlink", &mut at);
        std::fs::remove_file(r.join("link")).unwrap();
        write(&r, "link", b"t.txt\nnow a file\n");
        git(&r, &["add", "."]);
        commit(&r, "file", &mut at);
        assert_same(&r, Some("HEAD"), "link");
    }

    #[test]
    fn 尾部裁剪影响滑动() {
        // 相同的长尾（超过 1 KB）前有可上下滑动的重复行：git 先裁尾再 diff，组的位置因此不同
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        let tail: String = (0..80).map(|i| format!("    common tail line number {i}\n")).collect();
        let body = "}\n\nfn a() {\n}\n\nfn b() {\n}\n\n";
        write(&r, "s.rs", (body.to_string() + &tail).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        write(&r, "s.rs", (body.to_string() + "fn c() {\n}\n\n" + &tail).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "insert fn", &mut at);
        write(&r, "s.rs", (body.to_string() + "fn c() {\n}\n\n" + "}\n\n" + &tail).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "insert brace", &mut at);
        assert_same(&r, Some("HEAD"), "s.rs");

        // 重复行一直延伸进被裁掉的尾部：不裁尾时插入的那行落在末尾，裁尾后落在前面
        write(&r, "x.txt", format!("head\n{}", "x\n".repeat(1000)).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "xs", &mut at);
        write(&r, "x.txt", format!("head\n{}", "x\n".repeat(1001)).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "one more x", &mut at);
        let out = String::from_utf8(porcelain(&r, Some("HEAD"), "x.txt").unwrap()).unwrap();
        let head = git(&r, &["rev-parse", "HEAD"]);
        let last = out.lines().rev().find(|line| is_group_header(line)).unwrap();
        assert!(!last.starts_with(head.trim()), "最后一段不该归新提交：{last}");
        assert_same(&r, Some("HEAD"), "x.txt");
    }

    #[test]
    fn 合并时父提交顺序与整体让位() {
        // 两条分支各自加了同一行：合并里这一行在 diff 后归第一个父提交
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "f.txt", numbered("f", 0..6).as_bytes());
        write(&r, "g.txt", numbered("g", 0..6).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        git(&r, &["checkout", "-q", "-b", "side"]);
        write(&r, "f.txt", format!("{}dup\n", numbered("f", 0..6)).as_bytes());
        write(&r, "g.txt", format!("{}dup g\n", numbered("g", 0..6)).as_bytes());
        write(&r, "h.txt", b"same on both sides\n");
        git(&r, &["add", "."]);
        commit(&r, "side adds dup", &mut at);
        git(&r, &["checkout", "-q", "main"]);
        write(&r, "f.txt", format!("main\n{}dup\n", numbered("f", 1..6)).as_bytes());
        write(&r, "g.txt", format!("main g\n{}dup g\n", numbered("g", 1..6)).as_bytes());
        write(&r, "h.txt", b"same on both sides\n");
        git(&r, &["add", "."]);
        commit(&r, "main adds dup", &mut at);
        run(&r, &["merge", "-q", "--no-commit", "side"], Some(at + 60));
        // f.txt 与两边都不同；g.txt 与 side 完全相同（整份让给 side，不和 main 做 diff）
        write(&r, "f.txt", format!("main\n{}dup\nmerge\n", numbered("f", 1..6)).as_bytes());
        write(&r, "g.txt", format!("{}dup g\n", numbered("g", 0..6)).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "merge", &mut at);
        assert_same(&r, Some("HEAD"), "f.txt");
        assert_same(&r, Some("HEAD"), "g.txt");
        // h.txt 与两个父提交都相同：整份让给第一个
        assert_same(&r, Some("HEAD"), "h.txt");
        let main = git(&r, &["rev-parse", "HEAD^1"]);
        let side = git(&r, &["rev-parse", "HEAD^2"]);
        let owner = |file: &str, content: &str| {
            let out = String::from_utf8(porcelain(&r, Some("HEAD"), file).unwrap()).unwrap();
            let lines: Vec<&str> = out.lines().collect();
            let at = lines.iter().position(|line| *line == format!("\t{content}")).unwrap();
            lines[..at].iter().rev().find(|line| is_group_header(line)).unwrap()[..40].to_string()
        };
        assert_eq!(owner("f.txt", "dup"), main.trim());
        assert_eq!(owner("g.txt", "dup g"), side.trim());
        assert_eq!(owner("h.txt", "same on both sides"), main.trim());
    }

    #[test]
    fn 路径引号与非ascii() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "目录/文件 名.txt", b"1\n2\n");
        git(&r, &["add", "."]);
        commit(&r, "中文", &mut at);
        git(&r, &["mv", "目录/文件 名.txt", "tab\there.txt"]);
        write(&r, "tab\there.txt", b"1\n2\n3\n");
        git(&r, &["add", "."]);
        commit(&r, "rename", &mut at);
        assert_same(&r, Some("HEAD"), "tab\there.txt");
        git(&r, &["config", "core.quotePath", "false"]);
        assert_same(&r, Some("HEAD"), "tab\there.txt");
    }

    #[test]
    fn 大文件多次修改() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        let mut lines: Vec<String> = (0..4000).map(|i| format!("row {} {}\n", i % 97, i % 13)).collect();
        write(&r, "big.txt", lines.concat().as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        let mut seed = 0x9e3779b97f4a7c15u64;
        for round in 0..12 {
            for _ in 0..40 {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                let pos = (seed % lines.len() as u64) as usize;
                match seed % 3 {
                    0 => lines[pos] = format!("edit {round} {}\n", seed % 7),
                    1 => lines.insert(pos, format!("row {} {}\n", seed % 97, seed % 13)),
                    _ => {
                        lines.remove(pos);
                    }
                }
            }
            write(&r, "big.txt", lines.concat().as_bytes());
            git(&r, &["add", "."]);
            commit(&r, &format!("round {round}"), &mut at);
        }
        assert_same(&r, Some("HEAD"), "big.txt");
    }

    #[test]
    fn 让位的情形() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "a.txt", b"1\n");
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        write(&r, ".mailmap", b"Someone <t@t.t>\n");
        assert!(porcelain(&r, Some("HEAD"), "a.txt").is_err());
        std::fs::remove_file(r.join(".mailmap")).unwrap();
        git(&r, &["config", "diff.algorithm", "histogram"]);
        assert!(porcelain(&r, Some("HEAD"), "a.txt").is_err());
        git(&r, &["config", "--unset", "diff.algorithm"]);
        write(&r, ".gitattributes", b"*.txt diff=foo\n");
        assert!(porcelain(&r, Some("HEAD"), "a.txt").is_err());
        std::fs::remove_file(r.join(".gitattributes")).unwrap();
        assert!(porcelain(&r, Some("HEAD"), "missing.txt").is_err());
        assert!(porcelain(&r, None, "untracked.txt").is_err());
        assert_same(&r, Some("HEAD"), "a.txt");
    }

    #[test]
    fn 符号链接与工作区可执行位() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        std::os::unix::fs::symlink("target/one", r.join("l")).unwrap();
        write(&r, "x.sh", b"echo 1\necho 2\n");
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        std::fs::remove_file(r.join("l")).unwrap();
        std::os::unix::fs::symlink("target/two", r.join("l")).unwrap();
        git(&r, &["add", "."]);
        commit(&r, "relink", &mut at);
        assert_same(&r, Some("HEAD"), "l");
        assert_same(&r, None, "l");
        std::fs::remove_file(r.join("l")).unwrap();
        std::os::unix::fs::symlink("target/three", r.join("l")).unwrap();
        assert_same(&r, None, "l");
        // 工作区换成普通文件：类型和 HEAD 不同，交给 git
        std::fs::remove_file(r.join("l")).unwrap();
        write(&r, "l", b"target/two");
        assert!(porcelain(&r, None, "l").is_err());
        // 只改工作区的可执行位
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(r.join("x.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_same(&r, None, "x.sh");
        write(&r, "x.sh", b"echo 1\necho 3\n");
        assert_same(&r, None, "x.sh");
    }

    #[test]
    fn 合并进行中的工作区() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "c.txt", numbered("c", 0..10).as_bytes());
        write(&r, "w.txt", numbered("w", 0..30).as_bytes());
        write(&r, "y.txt", numbered("y", 0..10).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        git(&r, &["checkout", "-q", "-b", "side"]);
        write(&r, "c.txt", format!("side\n{}", numbered("c", 1..10)).as_bytes());
        write(&r, "w.txt", format!("{}side w\n{}", numbered("w", 0..25), numbered("w", 26..30)).as_bytes());
        write(&r, "y.txt", format!("{}side y\n", numbered("y", 0..10)).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "side", &mut at);
        git(&r, &["checkout", "-q", "main"]);
        write(&r, "c.txt", format!("main\n{}", numbered("c", 1..10)).as_bytes());
        write(&r, "w.txt", format!("main w\n{}", numbered("w", 1..30)).as_bytes());
        git(&r, &["add", "."]);
        commit(&r, "main", &mut at);
        // c.txt 冲突（带冲突标记）；w.txt 两边改的地方不同，自动合并；y.txt 只有 side 改
        assert!(!run(&r, &["merge", "-q", "--no-edit", "side"], Some(at + 60)).status.success());
        assert!(r.join(".git/MERGE_HEAD").exists());
        assert_same(&r, None, "w.txt");
        assert_same(&r, None, "y.txt");
        // 未合并的文件照样 blame：fake_working_tree_commit 用 stage 0 的条目换掉它
        assert_same(&r, None, "c.txt");
        let merged = std::fs::read_to_string(r.join("w.txt")).unwrap();
        write(&r, "w.txt", format!("{merged}worktree\n").as_bytes());
        assert_same(&r, None, "w.txt");
        // MERGE_HEAD 里写的不是提交：git 报错，交给它
        let tree = git(&r, &["rev-parse", "HEAD^{tree}"]);
        std::fs::write(r.join(".git/MERGE_HEAD"), tree).unwrap();
        assert!(porcelain(&r, None, "y.txt").is_err());
    }

    #[test]
    fn 属性与行尾转换() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, ".gitattributes", b"*.lf text=auto\n*.bin -text\n*.id ident\n");
        write(&r, "a.lf", b"1\n2\n");
        write(&r, "b.bin", b"1\r\n2\r\n");
        write(&r, "c.id", b"$Id$\n");
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        write(&r, "a.lf", b"1\n2\n3\n");
        write(&r, "b.bin", b"1\r\n2\r\n3\r\n");
        // 没有 CRLF 时 text=auto 不改内容；-text 不转换
        assert_same(&r, None, "a.lf");
        assert_same(&r, None, "b.bin");
        assert_same(&r, Some("HEAD"), "b.bin");
        // 有 CRLF 时 text=auto 会转换：交给 git
        write(&r, "a.lf", b"1\r\n2\n");
        assert!(porcelain(&r, None, "a.lf").is_err());
        assert!(porcelain(&r, None, "c.id").is_err());
        // core.autocrlf 同理
        write(&r, "a.lf", b"1\n2\n3\n");
        git(&r, &["config", "core.autocrlf", "input"]);
        assert_same(&r, None, "a.lf");
        assert!(porcelain(&r, None, "b.bin").is_ok());
        write(&r, "plain.txt", b"x\r\n");
        git(&r, &["add", "plain.txt"]);
        commit(&r, "plain", &mut at);
        write(&r, "plain.txt", b"x\r\ny\r\n");
        assert!(porcelain(&r, None, "plain.txt").is_err());
        git(&r, &["config", "core.autocrlf", "false"]);
        assert_same(&r, None, "plain.txt");
    }

    /// 简单的 xorshift，结果可复现。
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    const VOCABULARY: [&str; 12] =
        ["{", "}", "", "    return;", "fn x() {", "// note", "let a = 1;", "  ", "end", "\tindent", "}", "a\r"];

    fn random_content(rng: &mut Rng, base: &str) -> String {
        let mut lines: Vec<String> = base.lines().map(str::to_string).collect();
        for _ in 0..1 + rng.below(6) {
            let pos = if lines.is_empty() { 0 } else { rng.below(lines.len() + 1) };
            match rng.below(4) {
                0 | 1 => lines.insert(pos, VOCABULARY[rng.below(VOCABULARY.len())].to_string()),
                2 if pos < lines.len() => {
                    lines.remove(pos);
                }
                _ if pos < lines.len() => lines[pos] = format!("changed {}", rng.below(5)),
                _ => lines.push(format!("appended {}", rng.below(3))),
            }
        }
        let mut out = lines.join("\n");
        if rng.below(5) != 0 {
            out.push('\n');
        }
        out
    }

    fn random_history(seed: u64) -> (tempfile::TempDir, std::path::PathBuf) {
        let (d, r) = repo();
        let mut rng = Rng(seed);
        let mut at = 1_700_000_000;
        let mut files: Vec<String> = Vec::new();
        for i in 0..3 {
            let name = format!("f{i}.txt");
            write(
                &r,
                &name,
                (0..10).map(|k| format!("{} {k}\n", VOCABULARY[k % VOCABULARY.len()])).collect::<String>().as_bytes(),
            );
            files.push(name);
        }
        git(&r, &["add", "."]);
        commit(&r, "root", &mut at);
        let mut branches = vec!["main".to_string()];
        for step in 0..30 {
            match rng.below(10) {
                0 if branches.len() < 3 => {
                    let name = format!("b{step}");
                    git(&r, &["checkout", "-q", "-b", &name]);
                    branches.push(name);
                    continue;
                }
                1 if branches.len() > 1 => {
                    let other = branches[rng.below(branches.len())].clone();
                    let current = git(&r, &["rev-parse", "--abbrev-ref", "HEAD"]).trim().to_string();
                    if other != current {
                        let _ = run(&r, &["merge", "-q", "--no-ff", "--no-commit", &other], Some(at));
                        // 冲突一律取两边之一或拼在一起
                        let conflicted = ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U"];
                        for file in git(&r, &conflicted).lines() {
                            let theirs = run(&r, &["show", &format!(":3:{file}")], None).stdout;
                            let ours = run(&r, &["show", &format!(":2:{file}")], None).stdout;
                            let content = match rng.below(3) {
                                0 => theirs,
                                1 => ours,
                                _ => [ours, theirs].concat(),
                            };
                            write(&r, file, &content);
                            git(&r, &["add", "--", file]);
                        }
                        let _ = run(&r, &["add", "-A"], None);
                        commit(&r, &format!("merge {other}"), &mut at);
                    }
                    continue;
                }
                2 => {
                    let current = git(&r, &["rev-parse", "--abbrev-ref", "HEAD"]).trim().to_string();
                    let other = branches[rng.below(branches.len())].clone();
                    if other != current {
                        git(&r, &["checkout", "-q", &other]);
                    }
                    continue;
                }
                _ => {}
            }
            let tracked: Vec<String> = tracked(&r).into_iter().filter(|f| f.ends_with(".txt")).collect();
            if tracked.is_empty() {
                break;
            }
            let file = tracked[rng.below(tracked.len())].clone();
            match rng.below(8) {
                0 => {
                    // 非 ASCII 目录：版本 1 的过滤器哈希对高位字节按平台 char 处理
                    let target = format!("{}/r{step}.txt", ["d0", "d1", "目录é"][rng.below(3)]);
                    std::fs::create_dir_all(r.join(&target).parent().unwrap()).unwrap();
                    git(&r, &["mv", &file, &target]);
                    if rng.below(2) == 0 {
                        let base = std::fs::read_to_string(r.join(&target)).unwrap();
                        write(&r, &target, random_content(&mut rng, &base).as_bytes());
                    }
                }
                1 => {
                    let base = std::fs::read_to_string(r.join(&file)).unwrap();
                    write(&r, &format!("n{step}.txt"), random_content(&mut rng, &base).as_bytes());
                }
                _ => {
                    let base = std::fs::read_to_string(r.join(&file)).unwrap();
                    write(&r, &file, random_content(&mut rng, &base).as_bytes());
                }
            }
            git(&r, &["add", "-A"]);
            if rng.below(6) == 0 {
                at -= 600;
            }
            commit(&r, &format!("step {step}"), &mut at);
        }
        (d, r)
    }

    /// 跟踪的文件（不加引号）
    fn tracked(r: &Path) -> Vec<String> {
        git(r, &["-c", "core.quotePath=false", "ls-files", "-z"])
            .split('\0')
            .filter(|f| !f.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// commit-graph 文件里一个 chunk 的 (起点, 长度)
    fn graph_chunk(data: &[u8], id: &[u8; 4]) -> Option<(usize, usize)> {
        let count = usize::from(data[6]);
        (0..count).find_map(|i| {
            let at = 8 + 12 * i;
            let offset = |at: usize| u64::from_be_bytes(data[at..at + 8].try_into().unwrap()) as usize;
            (&data[at..at + 4] == id).then(|| (offset(at + 4), offset(at + 16) - offset(at + 4)))
        })
    }

    fn graph_file(r: &Path) -> std::path::PathBuf {
        r.join(".git/objects/info/commit-graph")
    }

    /// 改写单文件 commit-graph（git 读取时不校验校验和）
    fn patch_graph(r: &Path, patch: impl FnOnce(&mut Vec<u8>)) {
        patch_file(&graph_file(r), patch);
    }

    fn patch_file(path: &Path, patch: impl FnOnce(&mut Vec<u8>)) {
        let mut data = std::fs::read(path).unwrap();
        patch(&mut data);
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions).unwrap();
        std::fs::write(path, data).unwrap();
    }

    fn write_graph(r: &Path, version: Option<u32>) {
        let _ = std::fs::remove_file(graph_file(r));
        let _ = std::fs::remove_dir_all(r.join(".git/objects/info/commit-graphs"));
        let mut args = vec![];
        let config = version.map(|v| format!("commitGraph.changedPathsVersion={v}"));
        if let Some(config) = &config {
            args.extend(["-c", config.as_str()]);
        }
        args.extend(["commit-graph", "write", "--reachable", "--changed-paths"]);
        git(r, &args);
    }

    /// 两层的 commit-graph 链：较早的提交一层（`early` 版本），其余一层（`top` 版本）
    fn write_layers(r: &Path, early: u32, top: u32) {
        let _ = std::fs::remove_file(graph_file(r));
        let _ = std::fs::remove_dir_all(r.join(".git/objects/info/commit-graphs"));
        let commits = git(r, &["rev-list", "--max-count=1", "--skip=8", "HEAD"]);
        let version = format!("commitGraph.changedPathsVersion={early}");
        let mut child = Command::new("git")
            .arg("-C")
            .arg(r)
            .args(["-c", &version, "commit-graph", "write", "--split=no-merge", "--changed-paths", "--stdin-commits"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write as _;
        child.stdin.take().unwrap().write_all(commits.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        let version = format!("commitGraph.changedPathsVersion={top}");
        git(r, &["-c", &version, "commit-graph", "write", "--split=no-merge", "--reachable", "--changed-paths"]);
        let chain = std::fs::read_to_string(r.join(".git/objects/info/commit-graphs/commit-graph-chain")).unwrap();
        assert_eq!(chain.lines().count(), 2);
    }

    /// 分层链里每一层的过滤器清零
    fn zero_layers(r: &Path) {
        for entry in std::fs::read_dir(r.join(".git/objects/info/commit-graphs")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "graph") {
                patch_file(&path, |data| {
                    if let Some((start, size)) = graph_chunk(data, b"BDAT") {
                        data[start + 12..start + size].fill(0);
                    }
                });
            }
        }
    }

    /// 过滤器可能有假阴性时：我们给出结果就必须与 git 逐字节相同；git 报错时我们必须让位。
    /// 返回 (让位的个数, git 因为信任过滤器而与不用过滤器时结果不同的文件数)。
    fn check_all(r: &Path) -> (usize, usize) {
        let (mut refused, mut skewed) = (0, 0);
        for file in tracked(r) {
            let expected = run(r, &["blame", "--porcelain", "HEAD", "--", &file], None);
            let truth = run(r, &["-c", "core.commitGraph=false", "blame", "--porcelain", "HEAD", "--", &file], None);
            skewed += usize::from(truth.stdout != expected.stdout);
            match porcelain(r, Some("HEAD"), &file) {
                Ok(ours) => {
                    assert!(expected.status.success(), "{file}: git 失败但我们给出了结果");
                    assert!(
                        expected.stdout == ours,
                        "{file}\n--- git\n{}\n--- ours\n{}",
                        String::from_utf8_lossy(&expected.stdout),
                        String::from_utf8_lossy(&ours)
                    );
                }
                Err(_) => refused += 1,
            }
        }
        (refused, skewed)
    }

    /// changed-path 过滤器：有/无、版本 1/2、分层、图之后的新提交、配置关掉，以及人为制造的
    /// 假阴性（清零过滤器、改版本号模拟 `char` 无符号平台写出的版本 1、乱写索引）——git 照样信任
    /// 这些过滤器，跳过的比较不同就会得到不同的 blame，我们必须跟着一样。
    /// 过滤器漏报把路径「带进」一个其实没有它的提交（删掉后又加回来），再往下 diff 时 git 停在
    /// `die("internal error in blame::find_origin")`：引擎不能自己编一个结果，要让位
    #[test]
    fn 过滤器漏报到没有这个路径的提交时让位() {
        let (_d, r) = repo();
        let mut at = 1_700_000_000;
        write(&r, "f", b"a\n");
        write(&r, "g", b"x\n");
        git(&r, &["add", "f", "g"]);
        commit(&r, "one", &mut at);
        git(&r, &["rm", "-q", "f"]);
        commit(&r, "two", &mut at);
        write(&r, "f", b"b\n");
        git(&r, &["add", "f"]);
        commit(&r, "three", &mut at);
        write_graph(&r, None);
        let head = git(&r, &["rev-parse", "HEAD"]).trim().to_owned();
        let mut ids: Vec<String> = git(&r, &["rev-list", "--all"]).lines().map(str::to_owned).collect();
        ids.sort();
        let index = ids.iter().position(|id| *id == head).unwrap();
        patch_graph(&r, |data| {
            let (bidx, _) = graph_chunk(data, b"BIDX").unwrap();
            let (bdat, _) = graph_chunk(data, b"BDAT").unwrap();
            let end_at =
                |i: usize| u32::from_be_bytes(data[bidx + 4 * i..bidx + 4 * i + 4].try_into().unwrap()) as usize;
            let (start, end) = (if index == 0 { 0 } else { end_at(index - 1) }, end_at(index));
            assert!(end > start);
            data[bdat + 12 + start..bdat + 12 + end].fill(0);
        });
        let out = run(&r, &["blame", "--porcelain", "HEAD", "--", "f"], None);
        assert!(!out.status.success(), "git 应当失败: {}", String::from_utf8_lossy(&out.stdout));
        assert!(porcelain(&r, Some("HEAD"), "f").is_err());
        // 不读过滤器时照常作答
        git(&r, &["config", "commitGraph.readChangedPaths", "false"]);
        assert_eq!(porcelain(&r, Some("HEAD"), "f").unwrap(), git_porcelain(&r, Some("HEAD"), "f"));
    }

    #[test]
    fn bloom过滤器与git逐字节一致() {
        let rounds: u64 = std::env::var("GITCUB_BLAME_ROUNDS").ok().and_then(|n| n.parse().ok()).unwrap_or(6);
        let (mut fallbacks, mut skewed) = (0, 0);
        let mut tally = |(refused, differing): (usize, usize)| {
            fallbacks += refused;
            skewed += differing;
        };
        for seed in 1..=rounds {
            let (_d, r) = random_history(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
            if seed % 2 == 0 {
                git(&r, &["repack", "-a", "-d", "-q"]);
            }
            let files = tracked(&r);
            // 正常的过滤器：两个版本都不让位
            for version in [None, Some(2)] {
                write_graph(&r, version);
                for file in &files {
                    assert_same(&r, Some("HEAD"), file);
                }
            }
            // 版本 2 写的过滤器把头部版本改成 1：键按版本 1 哈希，非 ASCII 路径对不上（假阴性）
            write_graph(&r, Some(2));
            patch_graph(&r, |data| {
                let (start, _) = graph_chunk(data, b"BDAT").unwrap();
                data[start..start + 4].copy_from_slice(&1u32.to_be_bytes());
            });
            tally(check_all(&r));
            // 配置只认版本 2：上面改过的版本 1 过滤器不用，和没有过滤器一样
            git(&r, &["config", "commitGraph.changedPathsVersion", "2"]);
            for file in &files {
                assert_same(&r, Some("HEAD"), file);
            }
            git(&r, &["config", "--unset", "commitGraph.changedPathsVersion"]);
            // 过滤器全清零：每个提交都说「没变」
            write_graph(&r, None);
            patch_graph(&r, |data| {
                let (start, size) = graph_chunk(data, b"BDAT").unwrap();
                data[start + 12..start + size].fill(0);
            });
            tally(check_all(&r));
            for (key, value) in [("core.commitGraph", "false"), ("commitGraph.readChangedPaths", "false")] {
                git(&r, &["config", key, value]);
                for file in &files {
                    assert_same(&r, Some("HEAD"), file);
                }
                git(&r, &["config", "--unset", key]);
            }
            // 世代号为 0 的提交（`GENERATION_NUMBER_INFINITY`）git 不查过滤器：不读 GDA2 时世代号是 CDAT 里的拓扑层级
            patch_graph(&r, |data| {
                let (start, size) = graph_chunk(data, b"CDAT").unwrap();
                for entry in (start..start + size).step_by(36) {
                    data[entry + 28] = 0;
                    data[entry + 29] = 0;
                    data[entry + 30] = 0;
                    data[entry + 31] &= 0x03;
                }
            });
            git(&r, &["config", "commitGraph.generationVersion", "1"]);
            for file in &files {
                assert_same(&r, Some("HEAD"), file);
            }
            git(&r, &["config", "--unset", "commitGraph.generationVersion"]);
            // 随机清掉一些字节、乱写一些索引（越界、递减的偏移 git 不用那个过滤器）
            let mut rng = Rng(seed + 99);
            write_graph(&r, None);
            patch_graph(&r, |data| {
                let (start, size) = graph_chunk(data, b"BDAT").unwrap();
                for _ in 0..size / 3 {
                    let at = start + 12 + rng.below(size - 12);
                    data[at] &= rng.next() as u8;
                }
                let (start, size) = graph_chunk(data, b"BIDX").unwrap();
                for _ in 0..3 {
                    let at = start + 4 * rng.below(size / 4);
                    let value = rng.below(size * 4) as u32;
                    data[at..at + 4].copy_from_slice(&value.to_be_bytes());
                }
            });
            tally(check_all(&r));
            // 分层：两层同版本（正常、清零），以及底层版本 1、上层版本 2——git 停用设置与最上层不同的层
            write_layers(&r, 1, 1);
            for file in &files {
                assert_same(&r, Some("HEAD"), file);
            }
            zero_layers(&r);
            tally(check_all(&r));
            write_layers(&r, 1, 2);
            zero_layers(&r);
            tally(check_all(&r));
            write_layers(&r, 1, 1);
            let mut at = 1_800_000_000;
            for (i, file) in files.iter().take(2).enumerate() {
                let base = std::fs::read_to_string(r.join(file)).unwrap();
                write(&r, file, random_content(&mut rng, &base).as_bytes());
                git(&r, &["add", "-A"]);
                commit(&r, &format!("after graph {i}"), &mut at);
            }
            for file in &files {
                assert_same(&r, Some("HEAD"), file);
            }
        }
        eprintln!("bloom 假阴性变体：git 结果因过滤器而变的 {skewed} 个，我们让位 {fallbacks} 个");
        assert!(skewed > 0, "假阴性变体没有改变 git 的结果，测不到跳过的语义");
    }

    /// Desktop 那样的历史：主线几乎全是短分支的合并，分支上才改文件。第一批预取（64 个提交）
    /// 在主线上就满了，合并带出来的支链要留到下一批接着走（`frontier`）；输出仍与 git 逐字节相同。
    #[test]
    fn 大量短分支合并时支链跨批次预取() {
        let (_d, r) = repo();
        const LINES: usize = 240;
        let render = |lines: &[String]| lines.iter().map(|line| format!("{line}\n")).collect::<String>();
        let mut stream = String::new();
        let mut mark = 0;
        let mut at = 1_700_000_000u64;
        let mut emit =
            |stream: &mut String, from: Option<usize>, merge: Option<usize>, lines: &[String], at: &mut u64| {
                mark += 1;
                *at += 60;
                let data = render(lines);
                stream.push_str(&format!("commit refs/heads/main\nmark :{mark}\n"));
                stream.push_str(&format!("committer T <t@t.t> {at} +0000\ndata 1\nc\n"));
                if let Some(from) = from {
                    stream.push_str(&format!("from :{from}\n"));
                }
                if let Some(merge) = merge {
                    stream.push_str(&format!("merge :{merge}\n"));
                }
                stream.push_str(&format!("M 100644 inline f.txt\ndata {}\n{data}\n", data.len()));
                mark
            };
        let mut main: Vec<String> = (0..LINES).map(|i| format!("base {i}")).collect();
        let mut tip = emit(&mut stream, None, None, &main, &mut at);
        for k in 0..150usize {
            let fork = main.clone();
            let mut side = fork.clone();
            let mut side_tip = tip;
            for j in 0..1 + k % 3 {
                side[(k * 7 + j * 13) % LINES] = format!("side {k} {j}");
                side_tip = emit(&mut stream, Some(side_tip), None, &side, &mut at);
            }
            // 分支开着时主线也改了一行（与分支不冲突）
            if k % 4 == 1 {
                let line = (k * 11 + 3) % LINES;
                if side[line] == fork[line] {
                    main[line] = format!("main {k}");
                    tip = emit(&mut stream, Some(tip), None, &main, &mut at);
                }
            }
            for (i, line) in side.iter().enumerate() {
                if *line != fork[i] {
                    main[i] = line.clone();
                }
            }
            tip = emit(&mut stream, Some(tip), Some(side_tip), &main, &mut at);
        }
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&r)
            .args(["fast-import", "--quiet"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child.stdin.take().unwrap().write_all(stream.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        git(&r, &["reset", "-q", "--hard", "main"]);
        assert_same(&r, Some("HEAD"), "f.txt");
        assert_same(&r, None, "f.txt");
        let (_, profile) = porcelain_profiled(&r, Some("HEAD"), "f.txt").unwrap();
        assert!(profile.carried > 0, "支链没有跨批次: {profile:?}");
    }

    #[test]
    fn 随机历史与git逐字节一致() {
        let rounds: u64 = std::env::var("GITCUB_BLAME_ROUNDS").ok().and_then(|n| n.parse().ok()).unwrap_or(12);
        let mut checked = 0;
        for seed in 1..=rounds {
            let (_d, r) = random_history(seed.wrapping_mul(0x2545f4914f6cdd1d));
            // 一半打成包（深 delta 链），走包读取和 delta 基缓存；另一半是松散对象
            if seed % 2 == 1 {
                git(&r, &["repack", "-a", "-d", "-f", "-q", "--depth=50", "--window=250"]);
            }
            for file in tracked(&r) {
                assert_same(&r, Some("HEAD"), &file);
                checked += 1;
            }
            // 工作区也改一个
            if let Some(file) = tracked(&r).first() {
                let mut rng = Rng(seed + 7);
                let base = std::fs::read_to_string(r.join(file)).unwrap();
                write(&r, file, random_content(&mut rng, &base).as_bytes());
                assert_same(&r, None, file);
            }
        }
        assert!(checked > 0);
    }

    /// 真实仓库按 `ls-files` 等距抽样，逐字节对照 `git blame --porcelain HEAD -- <file>`
    /// 与 `git blame --porcelain -- <file>`（工作区）。只读，不改仓库。release 下跑：
    /// `GITCUB_BLAME_REPOS=/a:/b cargo test --release -- --ignored 真实仓库`。
    #[test]
    #[ignore]
    fn 真实仓库抽样与git逐字节一致() {
        let repos = std::env::var("GITCUB_BLAME_REPOS").unwrap_or_default();
        let samples: usize = std::env::var("GITCUB_BLAME_SAMPLES").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        for repo in repos.split(':').filter(|path| !path.is_empty()) {
            let root = Path::new(repo);
            let files: Vec<String> =
                git(root, &["ls-files", "-z"]).split('\0').filter(|f| !f.is_empty()).map(str::to_string).collect();
            let step = (files.len() / samples.max(1)).max(1);
            let (mut same, mut refused, mut git_failed) = (0, 0, 0);
            let (mut ours_time, mut git_time) = (std::time::Duration::ZERO, std::time::Duration::ZERO);
            let mut mismatched = Vec::new();
            let mut timings = Vec::new();
            for file in files.iter().step_by(step).take(samples) {
                for revision in [Some("HEAD"), None] {
                    let git_before = git_time;
                    let ours_before = ours_time;
                    let started = std::time::Instant::now();
                    let mut args = vec!["blame", "--porcelain"];
                    args.extend(revision);
                    args.extend(["--", file.as_str()]);
                    let out = Command::new("git")
                        .env("GIT_NO_LAZY_FETCH", "1")
                        .arg("-C")
                        .arg(root)
                        .args(&args)
                        .output()
                        .unwrap();
                    git_time += started.elapsed();
                    let started = std::time::Instant::now();
                    let ours = porcelain(root, revision, file);
                    ours_time += started.elapsed();
                    match ours {
                        Err(reason) => {
                            eprintln!("{repo} {file} {revision:?}: refused: {reason}");
                            refused += 1;
                        }
                        Ok(_) if !out.status.success() => git_failed += 1,
                        Ok(ours) if normalize_now(&ours) == normalize_now(&out.stdout) => same += 1,
                        Ok(_) => mismatched.push(format!("{file} {revision:?}")),
                    }
                    timings.push((ours_time - ours_before, git_time - git_before, format!("{file} {revision:?}")));
                }
            }
            timings.sort_by_key(|timing| Reverse(timing.0));
            for (ours, git, name) in timings.iter().take(8) {
                eprintln!("  slowest {name}: ours {ours:?}, git {git:?}");
            }
            timings.sort_by(|a, b| {
                (b.0.as_secs_f64() / b.1.as_secs_f64()).total_cmp(&(a.0.as_secs_f64() / a.1.as_secs_f64()))
            });
            for (ours, git, name) in timings.iter().take(8) {
                eprintln!("  worst ratio {name}: ours {ours:?}, git {git:?}");
            }
            eprintln!(
                "{repo}: {same} identical, {refused} refused, {git_failed} git failed, {} mismatched; ours {ours_time:?}, git {git_time:?}",
                mismatched.len()
            );
            assert!(mismatched.is_empty(), "{repo}: {mismatched:?}");
        }
    }
}
