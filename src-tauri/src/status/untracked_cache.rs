//! 未跟踪文件遍历的进程内缓存。
//!
//! 思路同 git 的 untracked cache（dir.c `untracked_cache` / `valid_cached_dir`），但只存在本进程内存里，
//! 不写 `.git/index` 扩展、不改用户仓库。每个遍历时读过的目录记下：
//!
//! - 读它之前的 lstat 签名（dev、inode、mode、nlink、size、mtime 与 ctime 纳秒）。目录里增删改名任何条目，
//!   内核都会把它的 mtime 与 ctime 改成当前时间；ctime 无法被 `utimes` 改回去。
//! - 它的 `.gitignore` 读之前的 lstat（是符号链接时再加上目标的 stat）。
//! - 索引里它整棵子树的条目（路径、mode、flags，`.gitignore` 还有对象 id）的 128 位加和，按 ASCII 小写
//!   归并（gix 的忽略大小写查找只折叠 ASCII）。子目录是不是已跟踪、能不能进去都只取决于这些。
//! - 它是否含 `.git`、直接子项里有没有嵌套仓库：判断嵌套仓库要读 `.git` 里面的内容，目录签名覆盖不到，
//!   含这类子项的目录每次都重读（「易变」）。
//! - 遍历报出的直接子项（未跟踪文件、嵌套仓库）与进入过的子目录。
//!
//! 全局输入（`core.excludesFile`、全局 ignore、`info/exclude` 的内容，完整配置，遍历选项，环境里的
//! XDG/HOME）合成一个签名，变了就整体作废。
//!
//! 下一次遍历时，先并行 lstat 所有记录的目录：签名、忽略文件与索引子树都没变、也不易变的目录直接复用它的
//! 直接子项；子目录逐个校验（和 git 一样）。变了的目录要重读，它的父目录也要重读（子项的分类在父目录里做，
//! 例如出现了 `.git`）；某个目录的 `.gitignore` 变了，它整棵子树的记录作废。重读用同一个 gix-dir 遍历从该
//! 目录起走一次，遇到仍然有效的子目录就不进去、改用记录。要重读的地方太多时直接整体遍历。
//!
//! racy：签名里的时间与本次调用开始时间相差不到「时间粒度 + 余量」的目录不可信，下次必定重读（参照 git
//! `is_racy_timestamp`）。只有本地 APFS / HFS+ 卷上启用（`statfs`）；其他文件系统、判断不了的、跨设备
//! 的目录都不用缓存。缓存只留一个仓库（工作区 + 公共目录 + 索引路径），换仓库或出错就丢弃。

use super::untracked::{Visits, Walk};
use gix::bstr::{BStr, BString, ByteSlice};
use gix::dir::entry::{Kind, Status};
use gix::dir::walk::{Action, Delegate, ForDeletionMode};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

/// 缓存里路径的总字节数上限，超过就不留缓存。
const MAX_BYTES: usize = 64 << 20;
/// 增量重读时最多从这么多个目录起遍历；每次起遍历都要重新分类一遍路径上的各级目录（约 0.1–0.25 ms），
/// 再多就不如整体并行遍历。
const MAX_FRESH_ROOTS: usize = 16;

/// 签名的时间粒度与 racy 余量。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    granularity_ns: i128,
    margin_ns: i128,
}

impl Policy {
    pub(crate) const fn new(granularity: Duration, margin: Duration) -> Self {
        Policy { granularity_ns: granularity.as_nanos() as i128, margin_ns: margin.as_nanos() as i128 }
    }

    fn floor(&self, ns: i128) -> i128 {
        ns - ns.rem_euclid(self.granularity_ns.max(1))
    }

    /// 时间戳与本次调用开始时间至少隔开「一个粒度 + 余量」才可信：之后的任何改动都会落在更晚的粒度里。
    fn settled(&self, stat: &Stat, started: i128) -> bool {
        stat.mtime.max(stat.ctime) + self.granularity_ns.max(1) + self.margin_ns <= started
    }
}

/// 本地 APFS 时间戳是纳秒；HFS+ 只有秒。余量都留 1 秒，盖过时钟读数与文件时间戳的细微差异。
const APFS: Policy = Policy::new(Duration::from_nanos(1), Duration::from_secs(1));
const HFS: Policy = Policy::new(Duration::from_secs(1), Duration::from_secs(1));

/// 只有本地 APFS / HFS+ 卷才用缓存；网络卷、FAT/exFAT 等 mtime 不可靠或粒度更粗的，以及判断不了的，都不用。
#[cfg(target_os = "macos")]
pub(crate) fn policy_for(path: &Path) -> Option<Policy> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `path` 是以 NUL 结尾的路径，`info` 是足够大的输出缓冲区。
    if unsafe { libc::statfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: statfs 成功时填满了整个结构。
    let info = unsafe { info.assume_init() };
    if info.f_flags & libc::MNT_LOCAL as u32 == 0 {
        return None;
    }
    // SAFETY: f_fstypename 是内核写入的、以 NUL 结尾的定长字符串。
    let name = unsafe { std::ffi::CStr::from_ptr(info.f_fstypename.as_ptr()) };
    match name.to_bytes() {
        b"apfs" => Some(APFS),
        b"hfs" => Some(HFS),
        _ => None,
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn policy_for(_path: &Path) -> Option<Policy> {
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stat {
    dev: u64,
    ino: u64,
    mode: u32,
    nlink: u64,
    size: u64,
    mtime: i128,
    ctime: i128,
}

impl Stat {
    fn of(meta: &std::fs::Metadata, policy: &Policy) -> Self {
        let ns = |secs: i64, nanos: i64| policy.floor(i128::from(secs) * 1_000_000_000 + i128::from(nanos));
        Stat {
            dev: meta.dev(),
            ino: meta.ino(),
            mode: meta.mode(),
            nlink: meta.nlink(),
            size: meta.size(),
            mtime: ns(meta.mtime(), meta.mtime_nsec()),
            ctime: ns(meta.ctime(), meta.ctime_nsec()),
        }
    }

    /// 与 [`Stat::of`] 相同，取自 lstat 的原始结果（`Metadata` 包着的就是同一个 `struct stat`）。
    #[allow(clippy::unnecessary_cast)]
    fn of_raw(st: &libc::stat, policy: &Policy) -> Self {
        let ns = |secs: i64, nanos: i64| policy.floor(i128::from(secs) * 1_000_000_000 + i128::from(nanos));
        Stat {
            dev: st.st_dev as u64,
            ino: st.st_ino as u64,
            mode: st.st_mode as u32,
            nlink: st.st_nlink as u64,
            size: st.st_size as u64,
            mtime: ns(st.st_mtime as i64, st.st_mtime_nsec as i64),
            ctime: ns(st.st_ctime as i64, st.st_ctime_nsec as i64),
        }
    }
}

/// 一个目录的 `.gitignore`：不存在、存在（自身 lstat 与跟随链接后的 stat），或查不了。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IgnoreFile {
    Missing,
    Present { link: Stat, target: Option<Stat> },
    Unknown,
}

impl IgnoreFile {
    fn probe(dir: &Path, policy: &Policy) -> Self {
        let path = dir.join(".gitignore");
        match std::fs::symlink_metadata(&path) {
            Ok(meta) => {
                let target = if meta.file_type().is_symlink() {
                    match std::fs::metadata(&path) {
                        Ok(target) => Some(Stat::of(&target, policy)),
                        Err(_) => return IgnoreFile::Unknown,
                    }
                } else {
                    None
                };
                IgnoreFile::Present { link: Stat::of(&meta, policy), target }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => IgnoreFile::Missing,
            Err(_) => IgnoreFile::Unknown,
        }
    }

    fn settled(&self, policy: &Policy, started: i128) -> bool {
        match self {
            IgnoreFile::Missing => true,
            IgnoreFile::Present { link, target } => {
                policy.settled(link, started) && target.as_ref().is_none_or(|t| policy.settled(t, started))
            }
            IgnoreFile::Unknown => false,
        }
    }
}

/// 进入一个目录、gix 读它之前取的检查结果。
#[derive(Clone, Copy, Debug)]
pub(crate) struct DirProbe {
    stat: Option<Stat>,
    dot_git: bool,
    ignore: IgnoreFile,
}

fn probe_dir(workdir: &Path, rela: &BStr, policy: &Policy) -> DirProbe {
    let Ok(relative) = gix::path::from_bstr(rela) else {
        return DirProbe { stat: None, dot_git: true, ignore: IgnoreFile::Unknown };
    };
    let dir = workdir.join(relative);
    let stat = std::fs::symlink_metadata(&dir).ok().map(|meta| Stat::of(&meta, policy));
    // 只问有没有：`.git` 存在（不论是否有效）就让父目录每次都重读这个目录的分类
    let dot_git =
        !matches!(std::fs::symlink_metadata(dir.join(".git")), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    DirProbe { stat, dot_git, ignore: IgnoreFile::probe(&dir, policy) }
}

struct Record {
    stat: Stat,
    /// 目录签名可信：时间戳已经稳定、和工作区在同一设备上
    settled: bool,
    ignore: IgnoreFile,
    ignore_settled: bool,
    dot_git: bool,
    /// 直接子项里有嵌套仓库或含 `.git` 的子目录：它们的分类取决于签名覆盖不到的内容，每次都重读
    volatile: bool,
    index: u128,
    files: Vec<String>,
    subdirs: Vec<BString>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
struct Key {
    workdir: PathBuf,
    common_dir: PathBuf,
    index_path: PathBuf,
}

struct State {
    key: Key,
    global: u128,
    dev: u64,
    started: i128,
    index_checksum: Option<gix::ObjectId>,
    sums: HashMap<BString, u128>,
    records: HashMap<BString, Record>,
}

/// 上一次调用的情况，测试与基准用来确认缓存确实生效。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Outcome {
    /// 整体遍历（没有可用缓存，或要重读的地方太多）
    pub(crate) full: bool,
    /// 从记录复用的目录数
    pub(crate) reused: usize,
    /// 增量重读的起点数
    pub(crate) fresh_roots: usize,
}

/// 在打开仓库的线程上准备好的输入（gix 的仓库对象不能跨线程共享）。全局签名必须在构建忽略规则栈
/// （`Walk::new`）之前读：之后被改了，记下的是旧内容，下次一比就会作废。
pub(crate) struct Prepared {
    started: i128,
    policy: Policy,
    key: Key,
    global: u128,
    index_checksum: Option<gix::ObjectId>,
    /// stat 预检顺带 lstat 到的目录（见 [`Prepared::share_dir_stats`]）
    known: Option<std::sync::mpsc::Receiver<super::preload::DirStats>>,
}

impl Prepared {
    /// 校验记录时等 stat 预检送来它确认过的目录的 lstat，这些目录不再各自 lstat 一次。只在要校验记录时等，
    /// 缓存冷时不等；发送端没发就被丢掉（预检没做）时各目录自己 lstat。预检的 lstat 都在 `prepare` 之后取，
    /// 和校验时自己取一样晚于本次调用的开始时间。
    pub(crate) fn share_dir_stats(&mut self) -> std::sync::mpsc::SyncSender<super::preload::DirStats> {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        self.known = Some(receiver);
        sender
    }
}

fn now_ns() -> i128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos() as i128)
}

/// 两个不同种子的 SipHash 拼成 128 位。
struct Hash128(std::hash::DefaultHasher, std::hash::DefaultHasher);

impl Hash128 {
    fn new() -> Self {
        let mut second = std::hash::DefaultHasher::new();
        0x5bd1_e995_u32.hash(&mut second);
        Hash128(std::hash::DefaultHasher::new(), second)
    }

    fn add(&mut self, value: impl Hash) {
        value.hash(&mut self.0);
        value.hash(&mut self.1);
    }

    fn finish(&self) -> u128 {
        (u128::from(self.0.finish()) << 64) | u128::from(self.1.finish())
    }
}

fn file_contents(hasher: &mut Hash128, path: &Path) {
    hasher.add(path);
    match std::fs::read(path) {
        Ok(bytes) => hasher.add(&bytes),
        Err(e) => hasher.add(format!("{:?}", e.kind())),
    }
}

/// 不能用缓存时返回 None。
pub(crate) fn prepare(repo: &gix::Repository, index: &gix::index::File) -> Option<Prepared> {
    prepare_with(repo, index, policy_for(repo.workdir()?)?)
}

fn prepare_with(repo: &gix::Repository, index: &gix::index::File, policy: Policy) -> Option<Prepared> {
    let started = now_ns();
    let workdir = repo.workdir()?.to_owned();
    let mut global = Hash128::new();
    let options: gix::dir::walk::Options<'static> =
        repo.dirwalk_options().ok()?.emit_untracked(gix::dir::walk::EmissionMode::Matching).into();
    global.add(options);
    let config = repo.config_snapshot();
    global.add(config.plumbing().to_bstring());
    if let Some(file) = config.trusted_path("core.excludesFile").ok()? {
        file_contents(&mut global, &file);
    }
    // 没配 core.excludesFile 时 gix 用 XDG 的 git/ignore；两个候选都读，多读一个无害
    for (variable, suffix) in [("XDG_CONFIG_HOME", "git/ignore"), ("HOME", ".config/git/ignore")] {
        let value = std::env::var_os(variable);
        global.add(&value);
        if let Some(value) = value {
            file_contents(&mut global, &Path::new(&value).join(suffix));
        }
    }
    for dir in [repo.git_dir(), repo.common_dir()] {
        file_contents(&mut global, &dir.join("info").join("exclude"));
    }
    global.add(repo.git_dir());
    global.add(repo.current_dir());
    Some(Prepared {
        started,
        policy,
        key: Key { workdir, common_dir: repo.common_dir().to_owned(), index_path: repo.index_path() },
        global: global.finish(),
        index_checksum: index.checksum(),
        known: None,
    })
}

fn lowercase(path: &[u8]) -> BString {
    path.to_ascii_lowercase().into()
}

fn entry_hash(entry: &gix::index::Entry, path: &BStr) -> u128 {
    let mut hasher = Hash128::new();
    hasher.add(path.as_bytes());
    hasher.add(entry.mode.bits());
    hasher.add(entry.flags.bits());
    let name = &path[path.rfind_byte(b'/').map_or(0, |slash| slash + 1)..];
    if name.eq_ignore_ascii_case(b".gitignore") {
        hasher.add(entry.id.as_bytes());
    }
    hasher.finish()
}

/// 每个目录（ASCII 小写）下整棵子树索引条目哈希的加和。加法可交换，同一目录分几段出现、
/// 大小写不同的目录归并到一起都不影响结果。
fn index_sums(index: &gix::index::State) -> HashMap<BString, u128> {
    let mut sums: HashMap<BString, u128> = HashMap::new();
    let add = |sums: &mut HashMap<BString, u128>, path: &[u8], value: u128| {
        let sum = sums.entry(lowercase(path)).or_default();
        *sum = sum.wrapping_add(value);
    };
    let mut current: Vec<u8> = Vec::new();
    // 每层目录：(路径在 `current` 里的长度, 子树加和)
    let mut frames: Vec<(usize, u128)> = vec![(0, 0)];
    for entry in index.entries() {
        let path = entry.path(index);
        let dir = &path[..path.rfind_byte(b'/').unwrap_or(0)];
        while frames.len() > 1 {
            let (len, sum) = *frames.last().expect("frames");
            if dir.len() >= len && dir[..len] == current[..len] && (dir.len() == len || dir[len] == b'/') {
                break;
            }
            frames.pop();
            add(&mut sums, &current[..len], sum);
            let parent = frames.last_mut().expect("root frame");
            parent.1 = parent.1.wrapping_add(sum);
        }
        let mut len = frames.last().expect("root frame").0;
        while len < dir.len() {
            let start = if len == 0 { 0 } else { len + 1 };
            let end = dir[start..].find_byte(b'/').map_or(dir.len(), |slash| start + slash);
            frames.push((end, 0));
            len = end;
        }
        current.clear();
        current.extend_from_slice(dir);
        let top = frames.last_mut().expect("root frame");
        top.1 = top.1.wrapping_add(entry_hash(entry, path));
    }
    while let Some((len, sum)) = frames.pop() {
        add(&mut sums, &current[..len], sum);
        if let Some(parent) = frames.last_mut() {
            parent.1 = parent.1.wrapping_add(sum);
        }
    }
    sums
}

fn parent(path: &BStr) -> &BStr {
    path[..path.rfind_byte(b'/').unwrap_or(0)].as_bstr()
}

/// 增量重读用的委托：和并行遍历一样只报未跟踪文件，另外在仍然有效的子目录处不进去（交给记录）。
struct Fresh<'a> {
    root: &'a BStr,
    probe: &'a dyn Fn(&BStr) -> DirProbe,
    reuse: &'a dyn Fn(&BStr) -> bool,
    found: Vec<String>,
    visits: Visits<DirProbe>,
    reused: Vec<BString>,
    reused_set: HashSet<BString>,
}

impl Delegate for Fresh<'_> {
    fn emit(&mut self, entry: gix::dir::EntryRef<'_>, _collapsed: Option<Status>) -> Action {
        // 不进去的未跟踪目录会被当作一个条目报出来，它的内容来自记录
        if entry.disk_kind == Some(Kind::Directory) && self.reused_set.contains(entry.rela_path.as_ref()) {
            return Action::Continue(());
        }
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
        if !entry.status.can_recurse(entry.disk_kind, entry.pathspec_match, for_deletion, worktree_root_is_repository) {
            return false;
        }
        let path = entry.rela_path.as_ref();
        if path != self.root && (self.reuse)(path) {
            self.reused.push(path.to_owned());
            self.reused_set.insert(path.to_owned());
            return false;
        }
        self.visits.dirs.push((path.to_owned(), (self.probe)(path)));
        true
    }
}

/// 校验后每个记录的状态。
#[derive(Clone, Copy, Default)]
struct Check {
    /// 目录签名没变且可信（直接子项没变）
    same: bool,
    /// 上层的 `.gitignore` 变了，记录作废
    dropped: bool,
    /// 要重读：自己无效，或某个子目录签名变了（子目录的分类在这里做）
    read: bool,
}

#[derive(Default)]
pub(crate) struct Cache {
    state: Option<State>,
    pub(crate) last: Outcome,
}

impl Cache {
    pub(crate) fn clear(&mut self) {
        self.state = None;
    }

    /// 只校验记录、不遍历（基准分开测预检与校验用）：有记录时返回能复用的目录数。
    #[allow(dead_code)]
    pub(crate) fn validate(&self, prepared: &Prepared) -> Option<usize> {
        let state = self.state.as_ref()?;
        let checks = check(state, &prepared.key.workdir, &prepared.policy, prepared.known.as_ref());
        Some(checks.checks.iter().filter(|check| !check.read).count())
    }

    /// 与 [`Walk::run`] 相同的未跟踪文件集合（无序）。`prepared` 为 None 时不用缓存。
    pub(crate) fn untracked(
        &mut self, prepared: Option<Prepared>, mut walk: Walk<'_>, threads: usize,
    ) -> Result<Vec<String>, String> {
        let previous = self.state.take();
        self.last = Outcome { full: true, ..Outcome::default() };
        let Some(prepared) = prepared else {
            return walk.run(threads);
        };
        let Some(dev) = std::fs::symlink_metadata(&prepared.key.workdir).ok().map(|meta| meta.dev()) else {
            return walk.run(threads);
        };
        let previous = previous.filter(|state| {
            state.key == prepared.key
                && state.global == prepared.global
                && state.dev == dev
                // 时钟往回走了：时间戳的先后不再可信
                && state.started <= prepared.started
        });
        let mut sums = None;
        if let Some(mut state) = previous {
            if state.index_checksum.is_none() || state.index_checksum != prepared.index_checksum {
                state.sums = index_sums(walk.index());
            }
            match incremental(&prepared, state, &mut walk) {
                Ok(Incremental::Done { found, state, outcome }) => {
                    self.last = outcome;
                    self.state = state;
                    return Ok(found);
                }
                Ok(Incremental::TooMany(state)) => sums = Some(state.sums),
                Err(error) => log::warn!("未跟踪缓存增量遍历失败，改为整体遍历: {error}"),
            }
        }
        let sums = sums.unwrap_or_else(|| index_sums(walk.index()));
        let (found, state) = full(&prepared, walk, threads, sums, dev)?;
        self.state = state;
        Ok(found)
    }
}

/// 整体遍历并记下每个读过的目录。
fn full(
    prepared: &Prepared, walk: Walk<'_>, threads: usize, sums: HashMap<BString, u128>, dev: u64,
) -> Result<(Vec<String>, Option<State>), String> {
    let workdir = prepared.key.workdir.clone();
    let policy = prepared.policy;
    let probe = move |rela: &BStr| probe_dir(&workdir, rela, &policy);
    let (found, visits) = walk.run_visits(threads, Some(&probe))?;
    let mut records = HashMap::new();
    let state = build(prepared, &sums, dev, &found, visits, &[], &mut records).then(|| State {
        key: prepared.key.clone(),
        global: prepared.global,
        dev,
        started: prepared.started,
        index_checksum: prepared.index_checksum,
        sums,
        records,
    });
    Ok((found, state))
}

/// 把一次遍历读过的目录写成记录，并入 `records`（里面是沿用的记录，`reused` 是遍历中没进去、
/// 改用记录的子目录）。对不上或路径太多时返回 false，调用方不留缓存。
fn build(
    prepared: &Prepared, sums: &HashMap<BString, u128>, dev: u64, found: &[String], visits: Visits<DirProbe>,
    reused: &[BString], records: &mut HashMap<BString, Record>,
) -> bool {
    let policy = &prepared.policy;
    let mut fresh: HashMap<BString, Record> = HashMap::with_capacity(visits.dirs.len());
    for (dir, probe) in visits.dirs {
        let (stat, settled) = match probe.stat {
            Some(stat) => (stat, policy.settled(&stat, prepared.started) && stat.dev == dev),
            None => (Stat { dev: 0, ino: 0, mode: 0, nlink: 0, size: 0, mtime: 0, ctime: 0 }, false),
        };
        let index = sums.get(&lowercase(&dir)).copied().unwrap_or(0);
        let record = Record {
            stat,
            settled,
            ignore: probe.ignore,
            ignore_settled: probe.ignore.settled(policy, prepared.started),
            dot_git: probe.dot_git,
            volatile: false,
            index,
            files: Vec::new(),
            subdirs: Vec::new(),
        };
        if fresh.insert(dir, record).is_some() {
            return false;
        }
    }
    for path in found {
        // 文件只在读它所在的目录时报出
        let Some(record) = fresh.get_mut(parent(path.as_bytes().as_bstr())) else {
            return false;
        };
        record.files.push(path.clone());
    }
    for repository in &visits.repositories {
        if let Some(record) = fresh.get_mut(parent(repository.as_bytes().as_bstr())) {
            record.volatile = true;
        }
    }
    let mut links: Vec<(BString, bool)> = Vec::with_capacity(fresh.len() + reused.len());
    for (dir, record) in &fresh {
        links.push((dir.clone(), record.dot_git));
    }
    for dir in reused {
        let Some(record) = records.get(dir) else {
            return false;
        };
        links.push((dir.clone(), record.dot_git));
    }
    for (dir, dot_git) in links {
        if dir.is_empty() {
            continue;
        }
        let parent = parent(dir.as_ref());
        if let Some(record) = fresh.get_mut(parent) {
            record.subdirs.push(dir);
            record.volatile |= dot_git;
        } else if !records.get(parent).is_some_and(|record| record.subdirs.contains(&dir)) {
            // 父目录是沿用的记录时，这个目录只能是增量重读的起点，早已在父目录的子目录列表里
            return false;
        }
    }
    records.extend(fresh);
    let bytes: usize =
        records.iter().map(|(dir, record)| dir.len() + record.files.iter().map(String::len).sum::<usize>()).sum();
    bytes <= MAX_BYTES
}

enum Incremental {
    Done {
        found: Vec<String>,
        state: Option<State>,
        outcome: Outcome,
    },
    /// 要重读的地方太多，交回状态（复用算好的索引加和）
    TooMany(State),
}

/// 用记录作答，只重读变了的目录。
fn incremental(prepared: &Prepared, mut state: State, walk: &mut Walk<'_>) -> Result<Incremental, String> {
    if !state.records.contains_key(BStr::new("")) {
        return Ok(Incremental::TooMany(state));
    }
    let policy = prepared.policy;
    let workdir = prepared.key.workdir.clone();
    let checks = check(&state, &workdir, &policy, prepared.known.as_ref());
    // 全部复用（缓存热时的常见情况）：记录原样留着，不必逐个搬到新表里
    if checks.checks.len() == state.records.len() && checks.all_reused() {
        let found: Vec<String> = state.records.values().flat_map(|record| record.files.iter().cloned()).collect();
        let outcome = Outcome { full: false, reused: state.records.len(), fresh_roots: 0 };
        state.started = prepared.started;
        state.index_checksum = prepared.index_checksum;
        return Ok(Incremental::Done { found, state: Some(state), outcome });
    }
    let reuse = |path: &BStr| checks.get(path).is_some_and(|check| !check.read);

    // 先数要从几处起重读：重读的目录里，没法复用的子目录跟着一起读，能复用的从记录里接着往下走
    let mut roots = 0;
    let mut stack: Vec<(&BStr, bool)> = vec![(BStr::new(""), false)];
    while let Some((dir, inside_fresh)) = stack.pop() {
        let Some(record) = state.records.get(dir) else { continue };
        let reading = !reuse(dir);
        if reading && !inside_fresh {
            roots += 1;
            if roots > MAX_FRESH_ROOTS {
                return Ok(Incremental::TooMany(state));
            }
        }
        for subdir in &record.subdirs {
            stack.push((subdir.as_ref(), reading && !reuse(subdir.as_ref())));
        }
    }

    let probe = |rela: &BStr| probe_dir(&workdir, rela, &policy);
    let mut accelerate = None;
    let mut found = Vec::new();
    let mut kept: HashMap<BString, Record> = HashMap::new();
    let mut visits = Visits::<DirProbe>::default();
    let mut fresh_found = Vec::new();
    let mut reused_in_fresh = Vec::new();
    let mut outcome = Outcome::default();
    let mut replay: Vec<BString> = vec![BString::default()];
    let mut fresh_roots = Vec::new();
    loop {
        while let Some(dir) = replay.pop() {
            if !reuse(dir.as_ref()) {
                fresh_roots.push(dir);
                continue;
            }
            let record = state.records.remove(&dir).ok_or("记录缺失")?;
            found.extend(record.files.iter().cloned());
            replay.extend(record.subdirs.iter().cloned());
            outcome.reused += 1;
            kept.insert(dir, record);
        }
        let Some(root) = fresh_roots.pop() else { break };
        outcome.fresh_roots += 1;
        // 忽略大小写时 gix 要的大小写不敏感查找表，只在真要重读时建
        if accelerate.is_none() && walk.ignore_case() {
            accelerate = Some(walk.index().prepare_icase_backing());
        }
        let mut delegate = Fresh {
            root: root.as_ref(),
            probe: &probe,
            reuse: &reuse,
            found: Vec::new(),
            visits: Visits::default(),
            reused: Vec::new(),
            reused_set: HashSet::new(),
        };
        walk.walk_at(accelerate.as_ref(), root.as_ref(), &mut delegate)?;
        if delegate.visits.dirs.first().is_none_or(|(dir, _)| *dir != root) {
            return Err(format!("增量重读的起点 {root} 没有被遍历"));
        }
        fresh_found.append(&mut delegate.found);
        visits.dirs.append(&mut delegate.visits.dirs);
        visits.repositories.append(&mut delegate.visits.repositories);
        replay.extend(delegate.reused.iter().cloned());
        reused_in_fresh.append(&mut delegate.reused);
    }
    found.extend(fresh_found.iter().cloned());
    let ok = build(prepared, &state.sums, state.dev, &fresh_found, visits, &reused_in_fresh, &mut kept);
    state.records = kept;
    state.started = prepared.started;
    state.index_checksum = prepared.index_checksum;
    Ok(Incremental::Done { found, state: ok.then_some(state), outcome })
}

/// 校验的结论，按目录查。
struct Checks {
    position: HashMap<BString, usize>,
    checks: Vec<Check>,
}

impl Checks {
    fn get(&self, dir: &BStr) -> Option<Check> {
        self.position.get(dir).map(|&i| self.checks[i])
    }

    /// 每个能从根走到的记录都能复用
    fn all_reused(&self) -> bool {
        self.checks.iter().all(|check| !check.read)
    }
}

/// `items` 分给最多 `threads` 个线程各自映射，结果按原顺序。
fn par_map<T: Sync, R: Send>(items: &[T], threads: usize, f: &(dyn Fn(&T) -> R + Sync)) -> Vec<R> {
    let threads = threads.min(items.len().div_ceil(256)).max(1);
    if threads == 1 {
        return items.iter().map(f).collect();
    }
    let chunk = items.len().div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> =
            items.chunks(chunk).map(|part| scope.spawn(move || part.iter().map(f).collect::<Vec<_>>())).collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic)))
            .collect()
    })
}

/// lstat 所有记录的目录与在的 `.gitignore`，再自上而下算出每个记录能不能复用。
///
/// `known` 是 stat 预检送来的目录 lstat（见 [`Prepared::share_dir_stats`]）：索引里有条目的目录预检都会确认，
/// 这些目录先不 lstat，等预检送来；其余目录（根目录、未跟踪目录）和已有 `.gitignore` 的 lstat 在等的同时做完。
/// 预检没送（没做或出错）或送来的里面缺了的，收到之后再自己 lstat。
fn check(
    state: &State, workdir: &Path, policy: &Policy, known: Option<&std::sync::mpsc::Receiver<super::preload::DirStats>>,
) -> Checks {
    // 能从根走到的记录，先序排好：(目录, 父目录的下标)
    let mut order: Vec<(&BStr, &Record, usize)> = Vec::with_capacity(state.records.len());
    let mut stack: Vec<(&BStr, usize)> = vec![(BStr::new(""), usize::MAX)];
    while let Some((dir, parent)) = stack.pop() {
        let Some(record) = state.records.get(dir) else { continue };
        let i = order.len();
        order.push((dir, record, parent));
        for subdir in &record.subdirs {
            stack.push((subdir.as_ref(), i));
        }
    }
    let path_of = |dir: &BStr| gix::path::from_bstr(dir).ok().map(|relative| workdir.join(relative));
    let lstat_same = |dir: &BStr, record: &Record| {
        path_of(dir)
            .and_then(|path| std::fs::symlink_metadata(path).ok())
            .is_some_and(|meta| Stat::of(&meta, policy) == record.stat)
    };
    let probe_ignore = |dir: &BStr| path_of(dir).map_or(IgnoreFile::Unknown, |path| IgnoreFile::probe(&path, policy));
    // 等预检的目录：不是根目录、索引里在它下面有条目（签名不可信的记录在这之前就定为要重读，不用 lstat）
    let waiting = known.is_some();
    let awaited = |dir: &BStr| waiting && !dir.is_empty() && state.sums.contains_key(&lowercase(dir));
    // 不等预检的部分：(目录签名没变；None 等预检, `.gitignore`；None 要看签名再定)
    let early: Vec<(Option<bool>, Option<IgnoreFile>)> =
        par_map(&order, super::walk_threads(), &|&(dir, record, _)| {
            let same = if !record.settled {
                Some(false)
            } else if awaited(dir) {
                None
            } else {
                Some(lstat_same(dir, record))
            };
            // 不在的 `.gitignore`：目录没变时一定还不在，变了才要再查
            let ignore = (record.ignore != IgnoreFile::Missing).then(|| probe_ignore(dir));
            (same, ignore)
        });
    let mut same: Vec<Option<bool>> = early.iter().map(|(same, _)| *same).collect();
    let mut ignore: Vec<Option<IgnoreFile>> = early.into_iter().map(|(_, ignore)| ignore).collect();
    let mut position: HashMap<BString, usize> = HashMap::with_capacity(order.len());
    for (i, (dir, ..)) in order.iter().enumerate() {
        position.insert((*dir).to_owned(), i);
    }
    if let Some(dirs) = known.and_then(|receiver| receiver.recv().ok()) {
        for (dir, st) in &dirs {
            if let Some(&i) = position.get(dir)
                && same[i].is_none()
            {
                same[i] = Some(Stat::of_raw(st, policy) == order[i].1.stat);
            }
        }
    }
    let late: Vec<usize> =
        (0..order.len()).filter(|&i| same[i].is_none() || (ignore[i].is_none() && same[i] != Some(true))).collect();
    let resolved = par_map(&late, super::walk_threads(), &|&i| {
        let (dir, record, _) = order[i];
        let same = same[i].unwrap_or_else(|| lstat_same(dir, record));
        let ignore = ignore[i].or_else(|| (!same).then(|| probe_ignore(dir)));
        (same, ignore)
    });
    for (&i, (resolved_same, resolved_ignore)) in late.iter().zip(resolved) {
        same[i] = Some(resolved_same);
        ignore[i] = resolved_ignore;
    }

    let mut checks: Vec<Check> = Vec::with_capacity(order.len());
    // `.gitignore` 没变（且可信），子树的记录才不作废
    let mut ignore_ok: Vec<bool> = Vec::with_capacity(order.len());
    for (i, (dir, record, parent)) in order.iter().enumerate() {
        let same = same[i] == Some(true);
        // 不在的 `.gitignore` 只在目录变了时才查过；没查就是还不在
        let ignore = ignore[i].unwrap_or(IgnoreFile::Missing) == record.ignore;
        let ok = ignore && record.ignore_settled && record.ignore != IgnoreFile::Unknown;
        let dropped = *parent != usize::MAX && (checks[*parent].dropped || !ignore_ok[*parent]);
        let index = state.sums.get(&lowercase(dir)).copied().unwrap_or(0) == record.index;
        let valid = !dropped && same && ok && index && !record.volatile;
        checks.push(Check { same, dropped, read: !valid });
        ignore_ok.push(ok);
    }
    // 子目录签名变了（或被作废），它的分类要在父目录里重做
    for i in 0..checks.len() {
        let parent = order[i].2;
        if parent != usize::MAX && (!checks[i].same || checks[i].dropped) {
            checks[parent].read = true;
        }
    }
    Checks { position, checks }
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// 进程内唯一的缓存。并发调用时后来的一方拿不到缓存，整体遍历；各自的记录都自洽，谁最后放回都对。
pub(crate) fn untracked(prepared: Option<Prepared>, walk: Walk<'_>, threads: usize) -> Result<Vec<String>, String> {
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner).take().unwrap_or_default();
    let result = cache.untracked(prepared, walk, threads);
    if result.is_err() {
        cache.clear();
    }
    *CACHE.lock().unwrap_or_else(PoisonError::into_inner) = Some(cache);
    result
}

/// 丢掉缓存（基准测冷路径用）。
#[allow(dead_code)]
pub(crate) fn clear() {
    if let Some(cache) = CACHE.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// 纳秒时间戳、30 ms 余量：改动后等 40 ms 就能用上缓存，测试不必等一秒。
    const FAST: Policy = Policy::new(Duration::from_nanos(1), Duration::from_millis(30));
    const SETTLE: Duration = Duration::from_millis(40);

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

    fn mkdir(path: PathBuf) -> PathBuf {
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn init() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = mkdir(dir.path().join("repo"));
        git(&root, &["init", "-q", "-b", "main", "."]);
        git(&root, &["config", "user.email", "t@t.t"]);
        git(&root, &["config", "user.name", "t"]);
        (dir, root)
    }

    /// git 的判定（嵌套仓库带结尾的 `/`，去掉后比较）。
    fn via_git(root: &Path) -> Vec<String> {
        let out = git(root, &["--no-optional-locks", "status", "--porcelain=2", "-z", "--untracked-files=all"]);
        let mut paths: Vec<String> = out
            .split('\0')
            .filter_map(|record| record.strip_prefix("? "))
            .map(|path| path.trim_end_matches('/').to_string())
            .collect();
        paths.sort();
        paths
    }

    fn via_cold_walk(root: &Path) -> Vec<String> {
        let repo = crate::status::open_with_excludes(root).unwrap();
        let index = repo.index_or_empty().unwrap();
        let mut found = Walk::new(&repo, &index).unwrap().run(4).unwrap();
        found.sort();
        found
    }

    struct Harness {
        root: PathBuf,
        cache: Cache,
        policy: Policy,
        /// 每隔一次让整体遍历在每个目录处切分、切片，记录同样要对得上
        calls: usize,
        /// 固定校验记录的方式（见 `cached`），None 时四种轮换
        mode: Option<usize>,
        _dir: tempfile::TempDir,
    }

    impl Harness {
        fn new() -> Self {
            let (dir, root) = init();
            Harness { root, cache: Cache::default(), policy: FAST, calls: 0, mode: None, _dir: dir }
        }

        fn cached(&mut self) -> Vec<String> {
            let repo = crate::status::open_with_excludes(&self.root).unwrap();
            let index = repo.index_or_empty().unwrap();
            let mut prepared = prepare_with(&repo, &index, self.policy);
            assert!(prepared.is_some(), "测试仓库应能用缓存");
            let mut walk = Walk::new(&repo, &index).unwrap();
            self.calls += 1;
            // 四次里两次用 stat 预检送来的目录 lstat 校验记录，一次预检没送（发送端丢掉），一次不等预检
            let mode = self.mode.unwrap_or(self.calls % 4);
            if mode != 0 {
                let sender = prepared.as_mut().unwrap().share_dir_stats();
                if mode != 3 {
                    let settings = crate::status::preload::Settings::of(&repo).unwrap();
                    let mut dirs = crate::status::preload::DirStats::new();
                    crate::status::preload::unresolved_with_dirs(&index, &self.root, settings, 2, Some(&mut dirs))
                        .expect("非稀疏索引");
                    sender.send(dirs).unwrap();
                }
            }
            if self.calls.is_multiple_of(2) {
                walk.min_directories = 1;
                walk.partition_children = 1;
            }
            let mut found = self.cache.untracked(prepared, walk, 4).unwrap();
            // 测试仓库都很小：无论整体遍历怎么切分，读过的目录都要能写成记录
            assert!(self.cache.state.is_some(), "没有留下记录（{:?}）", self.cache.last);
            found.sort();
            found
        }

        /// 缓存、不用缓存的遍历与 git 三方一致；返回这次缓存的情况。
        fn check(&mut self, step: &str) -> Outcome {
            let cached = self.cached();
            let outcome = self.cache.last;
            let cold = via_cold_walk(&self.root);
            assert_eq!(cached, cold, "{step}: 缓存与不用缓存的遍历不同（{outcome:?}）");
            let trimmed: Vec<String> = cold.iter().map(|path| path.trim_end_matches('/').to_string()).collect();
            assert_eq!(trimmed, via_git(&self.root), "{step}: 与 git 不同");
            outcome
        }

        /// 等时间戳稳定后再查两次：第二次必须用上缓存。
        fn settle(&mut self, step: &str) -> Outcome {
            std::thread::sleep(SETTLE);
            let first = self.check(step);
            let outcome = self.check(step);
            assert!(!outcome.full, "{step}: 稳定后应复用缓存（{first:?} → {outcome:?}）");
            assert!(outcome.reused > 0, "{step}: 应复用目录（{outcome:?}）");
            outcome
        }

        fn write(&self, path: &str, content: &str) {
            write(&self.root, path, content);
        }

        fn git(&self, args: &[&str]) -> String {
            git(&self.root, args)
        }

        fn path(&self, path: &str) -> PathBuf {
            self.root.join(path)
        }
    }

    fn base(h: &Harness) {
        for dir in ["", "src", "src/a", "src/a/b", "docs", "lib/deep/er"] {
            let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
            h.write(&format!("{prefix}tracked.txt"), "t\n");
        }
        h.write(".gitignore", "*.log\nbuild/\n");
        h.git(&["add", "-A"]);
        h.git(&["commit", "-qm", "base"]);
        h.write("src/new.rs", "u\n");
        h.write("src/a/untracked/inner/f.rs", "u\n");
        h.write("x.log", "u\n");
        h.write("build/out.o", "u\n");
    }

    #[test]
    fn 未跟踪缓存_增删改名文件与目录() {
        let mut h = Harness::new();
        base(&h);
        assert!(h.check("首次").full, "首次整体遍历");
        let settled = h.settle("无改动");
        assert_eq!(settled.fresh_roots, 0, "没有改动时不重读任何目录");

        h.write("src/a/b/added.txt", "u\n");
        let outcome = h.check("已有目录里新建文件");
        assert!(!outcome.full && outcome.fresh_roots > 0, "{outcome:?}");
        h.settle("新建后");
        std::fs::remove_file(h.path("src/new.rs")).unwrap();
        h.check("删除未跟踪文件");
        h.settle("删除后");
        std::fs::rename(h.path("src/a/b/added.txt"), h.path("src/a/b/renamed.txt")).unwrap();
        h.check("重命名未跟踪文件");
        h.settle("重命名后");
        std::fs::rename(h.path("src/a/untracked"), h.path("src/a/moved")).unwrap();
        h.check("重命名未跟踪目录");
        h.settle("目录重命名后");
        std::fs::rename(h.path("src/a/moved"), h.path("docs/moved")).unwrap();
        h.check("未跟踪目录移到别的目录");
        h.settle("移动后");
        h.write("brand/new/tree/x.txt", "u\n");
        h.write("brand/new/y.txt", "u\n");
        h.check("新建目录树");
        h.settle("新建目录树后");
        std::fs::remove_dir_all(h.path("brand/new")).unwrap();
        h.check("删除目录树");
        h.settle("删除目录树后");
        std::fs::remove_dir_all(h.path("src/a/b")).unwrap();
        h.check("删除含已跟踪文件的目录");
        h.settle("删除已跟踪目录后");
        // 未跟踪文件内容变化不影响列表
        h.write("docs/moved/inner/f.rs", "changed content\n");
        h.check("改写未跟踪文件内容");
        std::fs::create_dir_all(h.path("src/empty/nested")).unwrap();
        h.check("新建空目录");
        h.settle("空目录后");
        h.write("src/empty/nested/now.txt", "u\n");
        h.check("空目录里新建文件");
        h.settle("空目录新建后");
        // 改名后把目录 mtime 设回原值：mtime 不变，只有 ctime 记下了改动
        let dir = h.path("docs/moved/inner");
        let mtime = std::fs::metadata(&dir).unwrap().modified().unwrap();
        std::fs::rename(dir.join("f.rs"), dir.join("g.rs")).unwrap();
        std::fs::File::open(&dir).unwrap().set_modified(mtime).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().modified().unwrap(), mtime);
        std::thread::sleep(SETTLE);
        h.check("改名后 mtime 被设回原值");
    }

    #[test]
    fn 未跟踪缓存_忽略规则变化() {
        let mut h = Harness::new();
        base(&h);
        h.write("src/a/keep.tmp", "u\n");
        h.write("src/a/b/also.tmp", "u\n");
        h.check("首次");
        h.settle("稳定");
        // 原地改写，长度不变
        h.write(".gitignore", "*.tmp\nbuild/\n");
        h.check("根 .gitignore 原地改写");
        h.settle("改写后");
        h.write(".gitignore", "*.log\n");
        h.check("根 .gitignore 改短");
        h.settle("改短后");
        h.write("src/a/.gitignore", "*.tmp\n!keep.tmp\n");
        h.check("新增嵌套 .gitignore");
        h.settle("嵌套后");
        h.write("src/a/.gitignore", "keep.tmp\n");
        h.check("改写嵌套 .gitignore");
        h.settle("嵌套改写后");
        std::fs::remove_file(h.path("src/a/.gitignore")).unwrap();
        h.check("删除嵌套 .gitignore");
        h.settle("删除嵌套后");
        // 符号链接的 .gitignore：目标内容变化
        h.write("rules/one", "*.rs\n");
        std::os::unix::fs::symlink("../../rules/one", h.path("src/a/.gitignore")).unwrap();
        h.check("符号链接 .gitignore");
        h.settle("链接后");
        h.write("rules/one", "*.tmp\n");
        h.check("符号链接 .gitignore 的目标改写");
        h.settle("目标改写后");

        h.write(".git/info/exclude", "*.rs\n");
        h.check("info/exclude");
        h.settle("exclude 后");
        h.write(".git/info/exclude", "*.tx\n");
        h.check("info/exclude 原地改写");
        h.settle("exclude 改写后");

        let global = h.root.parent().unwrap().join("global-ignore");
        std::fs::write(&global, "*.txt\n").unwrap();
        h.git(&["config", "core.excludesFile", global.to_str().unwrap()]);
        h.check("设置 core.excludesFile");
        h.settle("全局忽略后");
        std::fs::write(&global, "new*\n").unwrap();
        h.check("全局 ignore 文件内容");
        h.settle("全局改写后");
        let other = h.root.parent().unwrap().join("other-ignore");
        std::fs::write(&other, "*.o\nmoved/\n").unwrap();
        h.git(&["config", "core.excludesFile", other.to_str().unwrap()]);
        h.check("core.excludesFile 换路径");
        h.settle("换路径后");
        h.git(&["config", "core.excludesFile", "relative-ignore"]);
        h.write("relative-ignore", "untracked/\n");
        h.check("相对路径的 core.excludesFile");
        h.settle("相对路径后");
        h.write("relative-ignore", "inner/\n");
        h.check("相对路径的 core.excludesFile 内容");
        h.settle("相对路径改写后");
        h.git(&["config", "--unset", "core.excludesFile"]);
        h.check("取消 core.excludesFile");
    }

    #[test]
    fn 未跟踪缓存_索引变化() {
        let mut h = Harness::new();
        base(&h);
        h.write("src/a/b/c/new.txt", "u\n");
        h.check("首次");
        h.settle("稳定");
        h.git(&["add", "src/a/b/c/new.txt"]);
        let outcome = h.check("add 未跟踪文件");
        assert!(!outcome.full, "索引变化只重读相关目录：{outcome:?}");
        h.settle("add 后");
        h.git(&["rm", "-q", "--cached", "src/a/tracked.txt"]);
        h.check("rm --cached 已跟踪文件");
        h.settle("rm --cached 后");
        h.git(&["rm", "-q", "-r", "--cached", "lib"]);
        h.check("rm --cached 整个目录：目录变成未跟踪");
        h.settle("目录 rm --cached 后");
        h.git(&["add", "lib/deep"]);
        h.check("重新 add 子目录");
        h.settle("重新 add 后");
        h.git(&["add", "-f", "build/out.o"]);
        h.check("add -f 被忽略目录里的文件");
        h.settle("add -f 后");
        h.git(&["commit", "-qm", "more"]);
        h.check("提交");
        h.settle("提交后");
        h.git(&["update-index", "--skip-worktree", "docs/tracked.txt"]);
        h.check("skip-worktree");
        h.settle("skip-worktree 后");
        h.git(&["rm", "-q", "--cached", ".gitignore"]);
        h.check("rm --cached .gitignore");
        h.settle("rm .gitignore 后");
        h.git(&["reset", "-q", "--hard"]);
        h.check("reset --hard");
    }

    #[test]
    fn 未跟踪缓存_嵌套仓库出现与消失() {
        let mut h = Harness::new();
        base(&h);
        h.write("src/a/sub/inside.txt", "u\n");
        h.check("首次");
        h.settle("稳定");
        git(&h.path("src/a/sub"), &["init", "-q", "."]);
        let outcome = h.check("未跟踪目录变成嵌套仓库");
        // 子目录的分类在父目录里重做，不靠起点分类出错后的整体遍历兜底
        assert!(!outcome.full, "{outcome:?}");
        h.settle("嵌套仓库后");
        std::fs::remove_dir_all(h.path("src/a/sub/.git/refs")).unwrap();
        h.check("嵌套仓库的 .git 失效");
        h.settle("失效后");
        std::fs::remove_dir_all(h.path("src/a/sub/.git")).unwrap();
        h.check("嵌套仓库的 .git 消失");
        h.settle("消失后");
        std::fs::create_dir_all(h.path("src/a/sub/.git")).unwrap();
        h.check("空的 .git 目录");
        h.settle("空 .git 后");
        let elsewhere = mkdir(h.root.parent().unwrap().join("elsewhere"));
        git(&elsewhere, &["init", "-q", "."]);
        std::fs::remove_dir_all(h.path("src/a/sub/.git")).unwrap();
        h.write("src/a/sub/.git", &format!("gitdir: {}\n", elsewhere.join(".git").display()));
        h.check(".git 文件指向别处");
        h.settle(".git 文件后");
        std::fs::remove_file(h.path("src/a/sub/.git")).unwrap();
        h.check(".git 文件消失");
        h.settle("最后");
        // 已跟踪目录里冒出嵌套仓库，之后它的 HEAD 被删（目录签名都不变）
        git(&mkdir(h.path("docs/inner")), &["init", "-q", "."]);
        h.check("已跟踪目录里的嵌套仓库");
        h.settle("嵌套仓库稳定");
        std::fs::remove_file(h.path("docs/inner/.git/HEAD")).unwrap();
        h.check("嵌套仓库的 HEAD 被删");
        h.settle("HEAD 删后");
        std::fs::write(h.path("docs/inner/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        h.check("嵌套仓库的 HEAD 恢复");
    }

    #[test]
    fn 未跟踪缓存_符号链接与目录互换() {
        let mut h = Harness::new();
        base(&h);
        h.write("src/x/a.txt", "u\n");
        h.write("target/t.txt", "u\n");
        h.check("首次");
        h.settle("稳定");
        std::fs::remove_dir_all(h.path("src/x")).unwrap();
        std::os::unix::fs::symlink("../target", h.path("src/x")).unwrap();
        h.check("目录换成指向目录的符号链接");
        h.settle("链接后");
        h.write("target/more.txt", "u\n");
        h.check("链接目标里新建文件");
        h.settle("目标后");
        std::fs::remove_file(h.path("src/x")).unwrap();
        h.write("src/x/b.txt", "u\n");
        h.check("符号链接换回目录");
        h.settle("换回后");
        // 已跟踪文件换成目录
        std::fs::remove_file(h.path("docs/tracked.txt")).unwrap();
        h.write("docs/tracked.txt/inner.txt", "u\n");
        h.check("已跟踪文件换成目录");
        h.settle("文件换目录后");
        std::fs::remove_dir_all(h.path("docs/tracked.txt")).unwrap();
        std::os::unix::fs::symlink("nowhere", h.path("docs/tracked.txt")).unwrap();
        h.check("换成悬空符号链接");
    }

    #[test]
    fn 未跟踪缓存_大小写变化() {
        let mut h = Harness::new();
        base(&h);
        h.write("Mixed/Case/File.txt", "t\n");
        h.git(&["add", "Mixed"]);
        h.git(&["commit", "-qm", "mixed"]);
        h.write("Mixed/Case/new.txt", "u\n");
        for ignore_case in ["true", "false"] {
            h.git(&["config", "core.ignoreCase", ignore_case]);
            h.check(&format!("ignoreCase={ignore_case} 首次"));
            h.settle("稳定");
            std::fs::rename(h.path("Mixed/Case"), h.path("Mixed/case-tmp")).unwrap();
            std::fs::rename(h.path("Mixed/case-tmp"), h.path("Mixed/case")).unwrap();
            h.check("目录只改大小写");
            h.settle("改大小写后");
            std::fs::rename(h.path("Mixed/case/File.txt"), h.path("Mixed/case/tmp")).unwrap();
            std::fs::rename(h.path("Mixed/case/tmp"), h.path("Mixed/case/file.txt")).unwrap();
            h.check("文件只改大小写");
            h.settle("文件改大小写后");
            std::fs::rename(h.path("Mixed/case/file.txt"), h.path("Mixed/case/File.txt")).unwrap();
            std::fs::rename(h.path("Mixed/case"), h.path("Mixed/tmp")).unwrap();
            std::fs::rename(h.path("Mixed/tmp"), h.path("Mixed/Case")).unwrap();
            h.check("复原");
            h.settle("复原后");
            h.git(&["mv", "Mixed/Case/File.txt", "Mixed/Case/Other.txt"]);
            h.check("索引里改名");
            h.settle("索引改名后");
            h.git(&["mv", "Mixed/Case/Other.txt", "Mixed/Case/File.txt"]);
            h.check("索引里改回");
        }
        // 只改配置：磁盘上的目录是小写，索引里是大写；忽略大小写时它是已跟踪目录，否则整个目录未跟踪
        h.git(&["config", "core.ignoreCase", "true"]);
        std::fs::rename(h.path("Mixed/Case"), h.path("Mixed/tmp")).unwrap();
        std::fs::rename(h.path("Mixed/tmp"), h.path("Mixed/case")).unwrap();
        h.check("小写目录");
        h.settle("小写目录稳定");
        for ignore_case in ["false", "true"] {
            h.git(&["config", "core.ignoreCase", ignore_case]);
            h.check(&format!("只改 core.ignoreCase={ignore_case}"));
            h.settle("改配置后");
        }
    }

    #[test]
    fn 未跟踪缓存_深层目录() {
        let mut h = Harness::new();
        base(&h);
        let deep: String = (0..40).map(|i| format!("d{i}/")).collect();
        h.write(&format!("{deep}tracked.txt"), "t\n");
        h.git(&["add", "-A"]);
        h.git(&["commit", "-qm", "deep"]);
        h.write(&format!("{deep}u.txt"), "u\n");
        h.check("首次");
        h.settle("稳定");
        h.write(&format!("{deep}v.txt"), "u\n");
        let outcome = h.check("最深处新建文件");
        assert!(!outcome.full && outcome.fresh_roots == 1, "只从最深处的父目录重读：{outcome:?}");
        h.settle("新建后");
        h.write(&format!("{}x/y/z.txt", &deep[..deep.len() / 2]), "u\n");
        h.check("中间新建目录");
        h.settle("中间后");
        h.write("d0/.gitignore", "u.txt\n");
        h.check("上层 .gitignore 影响最深处");
        h.settle("上层忽略后");
        h.git(&["add", "-f", &format!("{deep}u.txt")]);
        h.check("最深处 add");
    }

    /// 用预检送来的目录 lstat 校验时（四种方式各跑一遍）：没改动时一个目录都不重读，只有 ctime 记下的改名
    /// 也能发现。
    #[test]
    fn 未跟踪缓存_用预检的目录_lstat_校验() {
        for mode in 0..4 {
            let mut h = Harness::new();
            h.mode = Some(mode);
            base(&h);
            h.check("首次");
            let outcome = h.settle("无改动");
            assert_eq!(outcome.fresh_roots, 0, "方式 {mode}：没有改动时不重读任何目录（{outcome:?}）");
            assert_eq!(outcome.reused, h.cache.state.as_ref().unwrap().records.len(), "方式 {mode}");
            // 已跟踪目录（由预检 lstat）与未跟踪目录（自己 lstat）里各改名一次，再把 mtime 设回原值
            for dir in ["src/a", "src/a/untracked/inner"] {
                let dir = h.path(dir);
                let name = if dir.ends_with("inner") { "f.rs" } else { "tracked.txt" };
                h.write(&format!("{}/u1.txt", dir.strip_prefix(&h.root).unwrap().display()), "u\n");
                h.settle(&format!("方式 {mode}：{name} 旁边新建"));
                let mtime_now = std::fs::metadata(&dir).unwrap().modified().unwrap();
                std::fs::rename(dir.join("u1.txt"), dir.join("u2.txt")).unwrap();
                std::fs::File::open(&dir).unwrap().set_modified(mtime_now).unwrap();
                std::thread::sleep(SETTLE);
                let outcome = h.check(&format!("方式 {mode}：{name} 旁边改名、mtime 设回"));
                assert!(outcome.fresh_roots > 0, "方式 {mode}：只有 ctime 记下的改名要重读（{outcome:?}）");
            }
        }
    }

    /// 同一秒内只改名、不碰 `.gitignore`（签名按秒截断后完全相同），记录由预检送来的 lstat 校验：
    /// 只能靠「签名不可信的记录不等预检、一律重读」发现。
    #[test]
    fn 未跟踪缓存_同一秒内改名_用预检的目录_lstat() {
        let mut h = Harness::new();
        h.mode = Some(1);
        h.policy = Policy::new(Duration::from_secs(1), Duration::ZERO);
        base(&h);
        h.write("src/a/one.txt", "u\n");
        let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
        let mut caught = 0;
        for round in 0..6 {
            std::thread::sleep(Duration::from_millis(1100));
            h.check(&format!("第 {round} 轮之前"));
            std::thread::sleep(Duration::from_nanos(1_000_000_000 - u64::from(now().subsec_nanos())));
            std::thread::sleep(Duration::from_millis(10));
            let before = now().as_secs();
            std::fs::rename(h.path("src/a/one.txt"), h.path("src/a/two.txt")).unwrap();
            h.check(&format!("第 {round} 轮第一次改名"));
            std::fs::rename(h.path("src/a/two.txt"), h.path("src/a/one.txt")).unwrap();
            h.check(&format!("第 {round} 轮同一秒内改回"));
            caught += usize::from(before == now().as_secs());
        }
        assert!(caught >= 3, "至少几轮要落在同一秒内才算测到：{caught}");
    }

    /// HFS+ 只有秒级时间戳：同一秒内的连续改动让目录签名不变，只能靠 racy 判定。时间戳按秒截断模拟它，
    /// 余量为零。
    #[test]
    fn 未跟踪缓存_同一秒内连续改动() {
        let mut h = Harness::new();
        h.policy = Policy::new(Duration::from_secs(1), Duration::ZERO);
        base(&h);
        h.write("src/a/one.txt", "u\n");
        h.write("src/a/.gitignore", "*.a\n");
        h.write("src/a/ignored.b", "u\n");
        h.write("src/a/ignored.a", "u\n");
        let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
        let mut caught = 0;
        for round in 0..6 {
            // 先等过一秒，让上一轮的改动稳定、目录被缓存；再等到下一秒刚开始，好让后面几步落在同一秒里
            std::thread::sleep(Duration::from_millis(1100));
            h.check(&format!("第 {round} 轮之前"));
            std::thread::sleep(Duration::from_nanos(1_000_000_000 - u64::from(now().subsec_nanos())));
            std::thread::sleep(Duration::from_millis(10));
            let before = now().as_secs();
            // 第一次改动后立刻遍历（记下的签名与改动同一秒），再在同一秒里改回去：
            // 改名不改条目数与名字长度，`.gitignore` 原地改写、长度不变，按秒截断后签名完全相同
            std::fs::rename(h.path("src/a/one.txt"), h.path("src/a/two.txt")).unwrap();
            h.write("src/a/.gitignore", "*.b\n");
            h.check(&format!("第 {round} 轮第一次改动"));
            std::fs::rename(h.path("src/a/two.txt"), h.path("src/a/one.txt")).unwrap();
            h.write("src/a/.gitignore", "*.a\n");
            h.check(&format!("第 {round} 轮同一秒内改回"));
            caught += usize::from(before == now().as_secs());
        }
        assert!(caught >= 3, "至少几轮要落在同一秒内才算测到：{caught}");
    }

    /// 随机操作序列：每一步都与 git 和不用缓存的遍历对照，隔几步等时间戳稳定，让缓存真正参与。
    #[test]
    fn 未跟踪缓存_随机操作序列与_git_一致() {
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = |n: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % n as u64) as usize
        };
        const NAMES: [&str; 7] = ["a", "b", "Gen", "out", "x y", "中", "node"];
        const FILES: [&str; 7] = ["f.rs", "g.txt", "h.log", "keep.log", "i.tmp", "README", ".hidden"];
        const RULES: [&str; 10] =
            ["*.log", "!keep.log", "gen/", "/out", "*.tmp", "node/", "!a/", "x y/", "*.txt", "!g.txt"];
        let mut h = Harness::new();
        let random_dir = |next: &mut dyn FnMut(usize) -> usize| -> String {
            (0..1 + next(4)).map(|_| NAMES[next(NAMES.len())]).collect::<Vec<_>>().join("/")
        };
        for _ in 0..60 {
            let path = format!("{}/{}", random_dir(&mut next), FILES[next(FILES.len())]);
            h.write(&path, "t\n");
        }
        h.git(&["add", "-A", "-f"]);
        h.git(&["commit", "-qm", "base"]);
        h.check("首次");
        let run = |root: &Path, args: &[&str]| {
            let _ = Command::new("git").arg("-C").arg(root).args(args).output();
        };
        let mut hits = 0;
        for step in 0..150 {
            let dir = random_dir(&mut next);
            let file = format!("{dir}/{}", FILES[next(FILES.len())]);
            let description = match next(13) {
                0..=2 => {
                    h.write(&file, "u\n");
                    format!("新建 {file}")
                }
                3 => {
                    let _ = std::fs::remove_file(h.path(&file));
                    format!("删除 {file}")
                }
                4 => {
                    let _ = std::fs::remove_dir_all(h.path(&dir));
                    format!("删除目录 {dir}")
                }
                5 => {
                    let target = random_dir(&mut next);
                    let _ = std::fs::create_dir_all(h.path(&target).parent().unwrap());
                    let _ = std::fs::rename(h.path(&dir), h.path(&target));
                    format!("改名 {dir} → {target}")
                }
                6 => {
                    let rules: String = (0..1 + next(3)).map(|_| format!("{}\n", RULES[next(RULES.len())])).collect();
                    let at = if next(3) == 0 { String::from(".gitignore") } else { format!("{dir}/.gitignore") };
                    h.write(&at, &rules);
                    format!("忽略规则 {at}")
                }
                7 => {
                    h.write(".git/info/exclude", RULES[next(RULES.len())]);
                    "info/exclude".into()
                }
                8 => {
                    run(&h.root, &["add", "-A", "--", &dir]);
                    format!("add {dir}")
                }
                9 => {
                    run(&h.root, &["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", &dir]);
                    format!("rm --cached {dir}")
                }
                10 => {
                    let nested = h.path(&dir);
                    if nested.join(".git").exists() {
                        let _ = std::fs::remove_dir_all(nested.join(".git"));
                        format!("拆掉嵌套仓库 {dir}")
                    } else if nested.is_dir() || !nested.exists() {
                        std::fs::create_dir_all(&nested).unwrap();
                        git(&nested, &["init", "-q", "."]);
                        format!("嵌套仓库 {dir}")
                    } else {
                        "跳过".into()
                    }
                }
                11 => {
                    let link = h.path(&format!("{dir}-link"));
                    if std::fs::symlink_metadata(&link).is_ok() {
                        let _ = std::fs::remove_file(&link);
                        format!("删除链接 {dir}-link")
                    } else {
                        let _ = std::fs::create_dir_all(link.parent().unwrap());
                        let _ = std::os::unix::fs::symlink(h.path(&dir), &link);
                        format!("链接 {dir}-link")
                    }
                }
                _ => {
                    std::thread::sleep(SETTLE);
                    "等待稳定".into()
                }
            };
            let outcome = h.check(&format!("第 {step} 步：{description}"));
            hits += usize::from(!outcome.full && outcome.reused > 0);
        }
        assert!(hits >= 20, "缓存应在多数步骤里参与：{hits}");
    }

    #[test]
    fn 未跟踪缓存_status_两次结果相同() {
        let (_dir, root) = init();
        write(&root, "tracked.txt", "t\n");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-qm", "base"]);
        write(&root, "dir/u.txt", "u\n");
        let untracked = |root: &Path| {
            let mut paths: Vec<String> = crate::status::status(root)
                .unwrap()
                .changes
                .into_iter()
                .filter(|change| change.kind == crate::status::ChangeKind::Untracked)
                .map(|change| change.path)
                .collect();
            paths.sort();
            paths
        };
        assert_eq!(untracked(&root), vec!["dir/u.txt"]);
        std::thread::sleep(Duration::from_millis(1100));
        assert_eq!(untracked(&root), vec!["dir/u.txt"]);
        write(&root, "dir/v.txt", "u\n");
        assert_eq!(untracked(&root), vec!["dir/u.txt", "dir/v.txt"]);
    }

    #[test]
    fn 索引加和按子树归并() {
        let (_dir, root) = init();
        for path in ["a/b/c.txt", "a/b.txt", "a-b/x", "a/z/y", "B/q", "b/r", "top"] {
            write(&root, path, "t\n");
        }
        git(&root, &["add", "-A"]);
        let repo = gix::open(&root).unwrap();
        let index = repo.index_or_empty().unwrap();
        let sums = index_sums(&index);
        let expect = |dir: &str| {
            let prefix = if dir.is_empty() { String::new() } else { format!("{}/", dir.to_ascii_lowercase()) };
            index
                .entries()
                .iter()
                .filter(|entry| entry.path(&index).to_ascii_lowercase().starts_with(prefix.as_bytes()))
                .fold(0u128, |sum, entry| sum.wrapping_add(entry_hash(entry, entry.path(&index))))
        };
        for dir in ["", "a", "a/b", "a-b", "a/z", "b"] {
            assert_eq!(sums.get(&lowercase(dir.as_bytes())).copied().unwrap_or(0), expect(dir), "{dir}");
        }
    }
}
