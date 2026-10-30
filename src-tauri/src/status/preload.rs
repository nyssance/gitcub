//! 已跟踪文件的 stat 预检（git `preload-index.c` 的做法）。
//!
//! gix 的已跟踪比较（`gix_status::index_as_worktree`）对每个条目先用 `SymlinkCheck` 确认路径上的各级目录
//! 不是符号链接（换目录时 lstat 新出现的各级），再用完整路径 `lstat`。这里做同样的检查，另外：
//!
//! - 同一目录下连续至少 [`DENSE`] 个条目时，打开这个目录一次（`O_DIRECTORY | O_NOFOLLOW`），对其中条目
//!   `fstatat(AT_SYMLINK_NOFOLLOW)`：内核只解析最后一级，取到的 `struct stat` 与 lstat 相同。打开目录本身
//!   约等于十次 lstat，条目少的目录仍逐个用完整路径 lstat。
//! - 只做 stat 与比较，不建 gix 每个线程的属性栈、过滤管线，也不经过它的结果通道。
//!
//! 判定照搬 gix `compute_status` 返回「没有变化」的那条路径：条目不带 skip-worktree / assume-valid /
//! fsmonitor / intent-to-add 标记、未冲突、是普通文件或符号链接；工作区里不是目录、类型与可执行位按
//! `core.symlinks` / `core.fileMode` 不变；stat 按 gix 的选项相符（`core.trustctime`、`core.checkStat`、纳秒与
//! 设备号）；空 blob 的条目 size 为 0（racy 时 git 会把 size 清零）；不 racy（mtime 早于索引时间戳）。满足的
//! 条目不再交给 gix（相当于 git preload 之后 `refresh_index` 跳过 `CE_UPTODATE` 的条目），gix 只比较剩下的
//! 子集（见 [`unresolved`]）。其余条目（路径上有符号链接或不是目录、stat 失败、不符、racy、子模块、稀疏目录项）原样留给 gix，
//! 结果因此与不预检时相同：预检只能让 gix 少做事，不会替它下结论说「变了」。

use gix::bstr::{BStr, BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stat, stat};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;
use std::sync::{Mutex, PoisonError};

/// 每个工作单元的条目数，与 git preload 和 gix 相同。
const CHUNK: usize = 500;
/// 同一目录下连续这么多个条目才打开目录、用 fstatat；更少时逐个完整路径 lstat。
pub(crate) const DENSE: usize = 16;

/// 决定「stat 相符」的配置，取自 gix 自己用的那几项（`Repository::stat_options` / `filesystem_options`）。
#[derive(Clone, Copy, Debug)]
pub(crate) struct Settings {
    pub(crate) stat: stat::Options,
    pub(crate) symlink: bool,
    pub(crate) executable_bit: bool,
    /// 见 [`DENSE`]；基准与测试里调它
    pub(crate) dense: usize,
}

impl Settings {
    pub(crate) fn of(repo: &gix::Repository) -> Result<Self, String> {
        let caps = repo.filesystem_options().map_err(|e| e.to_string())?;
        Ok(Settings {
            stat: repo.stat_options().map_err(|e| e.to_string())?,
            symlink: caps.symlink,
            executable_bit: caps.executable_bit,
            dense: DENSE,
        })
    }
}

/// 预检做了多少：`checked` 个条目取到了 stat，其中 `marked` 个与工作区相符。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub(crate) checked: usize,
    pub(crate) marked: usize,
}

/// 预检确认各级目录时 lstat 到的目录（工作区相对路径，不含根目录）。未跟踪缓存校验目录签名时直接用这些
/// 结果，不再对同一批目录各 lstat 一次（见 `untracked_cache`）。一个目录可能被几个线程各取一次，取哪次都行：
/// 都在本次调用开始之后。
pub(crate) type DirStats = Vec<(BString, libc::stat)>;

/// 预检后还要交给 gix 的条目：与 `state` 同样的时间戳与对象格式，只含不能断定没变的条目（冲突的各个
/// stage 都在、相对顺序不变）。gix 对每个条目的判定只看条目本身、工作区与同一路径的其他 stage，
/// 所以在这份子集上得到的已跟踪改动与在整个索引上相同。稀疏索引不预检，返回 `None`。
///
/// 只用于不让 gix 遍历未跟踪文件的场合（gix 的目录遍历要用完整索引判断哪些路径已跟踪）。
#[allow(dead_code)]
pub(crate) fn unresolved(
    state: &gix::index::State, workdir: &Path, settings: Settings, threads: usize,
) -> Option<(gix::index::State, Outcome)> {
    unresolved_with_dirs(state, workdir, settings, threads, None)
}

/// 同 [`unresolved`]，`dirs` 为 `Some` 时另外收集确认过的目录的 lstat（见 [`DirStats`]）。
pub(crate) fn unresolved_with_dirs(
    state: &gix::index::State, workdir: &Path, settings: Settings, threads: usize, dirs: Option<&mut DirStats>,
) -> Option<(gix::index::State, Outcome)> {
    if state.is_sparse() {
        return None;
    }
    let (clean, outcome) = up_to_date_entries_with_dirs(state, workdir, settings, threads, dirs);
    let mut rest = gix::index::State::new(state.object_hash());
    rest.set_timestamp(state.timestamp());
    for (entry, clean) in state.entries().iter().zip(clean) {
        if !clean {
            rest.dangerously_push_entry(entry.stat, entry.id, entry.flags, entry.mode, entry.path(state));
        }
    }
    Some((rest, outcome))
}

/// 每个条目是否 stat 相符且不 racy（与 `state.entries()` 一一对应）。
#[allow(dead_code)]
pub(crate) fn up_to_date_entries(
    state: &gix::index::State, workdir: &Path, settings: Settings, threads: usize,
) -> (Vec<bool>, Outcome) {
    up_to_date_entries_with_dirs(state, workdir, settings, threads, None)
}

fn up_to_date_entries_with_dirs(
    state: &gix::index::State, workdir: &Path, settings: Settings, threads: usize, dirs: Option<&mut DirStats>,
) -> (Vec<bool>, Outcome) {
    let collect = dirs.is_some();
    let collected = Mutex::new(DirStats::new());
    let timestamp = state.timestamp();
    let racy = move |stat: &Stat| stat.is_racy(timestamp, settings.stat);
    let (entries, backing) = (state.entries(), state.path_backing());
    let mut clean = vec![false; entries.len()];
    let threads = threads.clamp(1, entries.len().div_ceil(CHUNK).max(1));
    let chunks = Mutex::new(entries.chunks(CHUNK).zip(clean.chunks_mut(CHUNK)));
    let total = Mutex::new(Outcome::default());
    let root = workdir.as_os_str().as_encoded_bytes();
    let context = Context { backing, settings, racy: &racy };
    let work = || {
        let mut paths = Paths::new(root, collect);
        let mut outcome = Outcome::default();
        loop {
            let Some((chunk, clean)) = chunks.lock().unwrap_or_else(PoisonError::into_inner).next() else {
                break;
            };
            let mut start = 0;
            while start < chunk.len() {
                let dir = parent(chunk[start].path_in(backing));
                let same = chunk[start + 1..].iter().take_while(|e| parent(e.path_in(backing)) == dir).count();
                let end = start + 1 + same;
                paths.run(dir, &chunk[start..end], &mut clean[start..end], &context, &mut outcome);
                start = end;
            }
        }
        if collect {
            collected.lock().unwrap_or_else(PoisonError::into_inner).append(&mut paths.dirs);
        }
        let mut total = total.lock().unwrap_or_else(PoisonError::into_inner);
        total.checked += outcome.checked;
        total.marked += outcome.marked;
    };
    if threads == 1 {
        work();
    } else {
        std::thread::scope(|scope| {
            for _ in 0..threads {
                scope.spawn(work);
            }
        });
    }
    drop(chunks);
    if let Some(dirs) = dirs {
        *dirs = collected.into_inner().unwrap_or_else(PoisonError::into_inner);
    }
    (clean, total.into_inner().unwrap_or_else(PoisonError::into_inner))
}

fn parent(path: &BStr) -> &[u8] {
    &path[..path.rfind_byte(b'/').unwrap_or(0)]
}

/// 这个条目要不要做 stat（其余交给 gix）。
fn candidate(entry: &gix::index::Entry) -> bool {
    !entry.flags.intersects(Flags::SKIP_WORKTREE | Flags::ASSUME_VALID | Flags::FSMONITOR_VALID | Flags::INTENT_TO_ADD)
        && entry.stage_raw() == 0
        && matches!(entry.mode, Mode::FILE | Mode::FILE_EXECUTABLE | Mode::SYMLINK)
}

/// gix `compute_status` 在 lstat 之后判定「没有变化」的条件（intent-to-add 已在 [`candidate`] 里排除）。
/// `racy` 是按索引时间戳的判定（`Stat::is_racy`）。
pub(crate) fn up_to_date(
    entry: &gix::index::Entry, st: &libc::stat, settings: Settings, racy: &dyn Fn(&Stat) -> bool,
) -> bool {
    let kind = st.st_mode as u32 & libc::S_IFMT as u32;
    let is_file = kind == libc::S_IFREG as u32;
    let is_symlink = kind == libc::S_IFLNK as u32;
    if kind == libc::S_IFDIR as u32 {
        return false;
    }
    let is_executable = is_file && st.st_mode as u32 & libc::S_IXUSR as u32 != 0;
    if entry
        .mode
        .change_to_match_fs_with_values(
            is_file,
            false,
            is_symlink,
            is_executable,
            settings.symlink,
            settings.executable_bit,
        )
        .is_some()
    {
        return false;
    }
    let Some(new) = to_stat(st) else {
        return false;
    };
    new.matches(&entry.stat, settings.stat) && (!entry.id.is_empty_blob() || entry.stat.size == 0) && !racy(&new)
}

/// 与 `gix_index::entry::Stat::from_fs` 相同的换算（gix 的 `fs::Metadata` 包着同一个 `struct stat`，
/// ctime 取 `st_ctime`）。时间早于纪元或纳秒越界时 gix 会退成 0，这里干脆不下结论。
pub(crate) fn to_stat(st: &libc::stat) -> Option<Stat> {
    let time = |secs: i64, nanos: i64| -> Option<gix::index::entry::stat::Time> {
        if secs < 0 || !(0..1_000_000_000).contains(&nanos) {
            return None;
        }
        Some(gix::index::entry::stat::Time { secs: secs as u32, nsecs: nanos as u32 })
    };
    #[allow(clippy::unnecessary_cast)]
    Some(Stat {
        mtime: time(st.st_mtime as i64, st.st_mtime_nsec as i64)?,
        ctime: time(st.st_ctime as i64, st.st_ctime_nsec as i64)?,
        dev: st.st_dev as u64 as u32,
        ino: st.st_ino as u64 as u32,
        uid: st.st_uid as u32,
        gid: st.st_gid as u32,
        size: st.st_size as u64 as u32,
    })
}

fn stat_at(dir: RawFd, name: &[u8], buf: &mut Vec<u8>) -> Option<libc::stat> {
    if !c_path(buf, &[name]) {
        return None;
    }
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: buf 以 NUL 结尾且中间没有 NUL（c_path），st 由内核在成功时填满。
    let rc = unsafe { libc::fstatat(dir, buf.as_ptr().cast(), st.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
    // SAFETY: 返回 0 时 st 已初始化。
    (rc == 0).then(|| unsafe { st.assume_init() })
}

/// `buf` 须由 [`c_path`] 拼好。
fn lstat(buf: &[u8]) -> Option<libc::stat> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: buf 以 NUL 结尾且中间没有 NUL。
    let rc = unsafe { libc::lstat(buf.as_ptr().cast(), st.as_mut_ptr()) };
    // SAFETY: 返回 0 时 st 已初始化。
    (rc == 0).then(|| unsafe { st.assume_init() })
}

/// 把各段拼进 `buf` 并以 NUL 结尾；任何一段含 NUL 时返回 false。
fn c_path(buf: &mut Vec<u8>, parts: &[&[u8]]) -> bool {
    buf.clear();
    for part in parts {
        if part.contains(&0) {
            return false;
        }
        buf.extend_from_slice(part);
    }
    buf.push(0);
    true
}

fn is_dir(st: &libc::stat) -> bool {
    st.st_mode as u32 & libc::S_IFMT as u32 == libc::S_IFDIR as u32
}

/// 打开目录。`nofollow` 时最后一级是符号链接也打不开（ELOOP）。
fn open_dir(path: &[u8], nofollow: bool) -> Option<OwnedFd> {
    let mut buf = Vec::new();
    if !c_path(&mut buf, &[path]) {
        return None;
    }
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | if nofollow { libc::O_NOFOLLOW } else { 0 };
    // SAFETY: buf 以 NUL 结尾。
    let fd = unsafe { libc::open(buf.as_ptr().cast(), flags) };
    // SAFETY: open 成功返回的描述符归我们所有。
    (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd) })
}

/// 各线程共用的只读输入。
#[derive(Clone, Copy)]
struct Context<'a> {
    backing: &'a gix::index::PathStorageRef,
    settings: Settings,
    racy: &'a (dyn Fn(&Stat) -> bool + Sync),
}

/// 一个线程的路径状态：已确认是真目录（lstat 得到 S_IFDIR，不是符号链接）的各级前缀，
/// 相当于 gix `SymlinkCheck` / git `threaded_has_symlink_leading_path` 的缓存。
struct Paths<'a> {
    root: &'a [u8],
    /// 已确认的各级在 `current` 里的结束位置
    verified: Vec<usize>,
    current: Vec<u8>,
    /// 上一次确认失败的目录，同一目录的后续条目不再重试
    failed: Option<Vec<u8>>,
    buf: Vec<u8>,
    /// 收集 lstat 成功的各级目录（见 [`DirStats`]）
    collect: bool,
    dirs: DirStats,
}

impl<'a> Paths<'a> {
    fn new(root: &'a [u8], collect: bool) -> Self {
        Paths {
            root,
            verified: Vec::new(),
            current: Vec::new(),
            failed: None,
            buf: Vec::new(),
            collect,
            dirs: Vec::new(),
        }
    }

    /// `dir`（工作区相对路径）的每一级都是真目录。
    fn verify(&mut self, dir: &[u8]) -> bool {
        if dir.is_empty() || self.current == dir {
            return true;
        }
        if self.failed.as_deref() == Some(dir) {
            return false;
        }
        // 保留与 dir 共同的前几级
        while let Some(&end) = self.verified.last() {
            if dir.len() >= end && dir[..end] == self.current[..end] && (dir.len() == end || dir[end] == b'/') {
                break;
            }
            self.verified.pop();
        }
        let kept = self.verified.last().copied().unwrap_or(0);
        self.current.truncate(kept);
        if kept == dir.len() {
            return true;
        }
        let rest = if kept == 0 { dir } else { &dir[kept + 1..] };
        for component in rest.split(|b| *b == b'/') {
            let separator: &[u8] = if self.current.is_empty() { b"" } else { b"/" };
            let st = (!component.is_empty()
                && component != b"."
                && component != b".."
                && c_path(&mut self.buf, &[self.root, b"/", &self.current, separator, component]))
            .then(|| lstat(&self.buf))
            .flatten();
            if self.collect
                && let Some(st) = st
            {
                self.dirs.push(([&self.current[..], separator, component].concat().into(), st));
            }
            if !st.is_some_and(|st| is_dir(&st)) {
                self.failed = Some(dir.to_vec());
                return false;
            }
            self.current.extend_from_slice(separator);
            self.current.extend_from_slice(component);
            self.verified.push(self.current.len());
        }
        true
    }

    /// 处理同一目录 `dir` 下连续的一段条目，相符的在 `clean` 里对应位置记 true。
    fn run(
        &mut self, dir: &[u8], entries: &[gix::index::Entry], clean: &mut [bool], context: &Context<'_>,
        outcome: &mut Outcome,
    ) {
        let Context { backing, settings, racy } = *context;
        let candidates = entries.iter().filter(|e| candidate(e)).count();
        if candidates == 0 || !self.verify(dir) {
            return;
        }
        let name_start = if dir.is_empty() { 0 } else { dir.len() + 1 };
        let fd = if candidates >= settings.dense {
            // 工作区根目录本身可以经过符号链接（gix 也是顺着它走的）；下面各级已逐级确认过
            if dir.is_empty() { open_dir(self.root, false) } else { open_dir(&[self.root, b"/", dir].concat(), true) }
        } else {
            None
        };
        let mut buf = std::mem::take(&mut self.buf);
        for (entry, clean) in entries.iter().zip(clean).filter(|(e, _)| candidate(e)) {
            let path = entry.path_in(backing);
            let st = match &fd {
                Some(fd) => stat_at(fd.as_raw_fd(), &path[name_start..], &mut buf),
                None => c_path(&mut buf, &[self.root, b"/", path]).then(|| lstat(&buf)).flatten(),
            };
            let Some(st) = st else {
                continue;
            };
            outcome.checked += 1;
            if up_to_date(entry, &st, settings, racy) {
                outcome.marked += 1;
                *clean = true;
            }
        }
        self.buf = buf;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, SystemTime};

    fn git(root: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn write(root: &Path, path: &str, content: &[u8]) {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn set_mtime(root: &Path, path: &str, time: SystemTime) {
        std::fs::File::options().write(true).open(root.join(path)).unwrap().set_modified(time).unwrap();
    }

    fn mtime(root: &Path, path: &str) -> SystemTime {
        std::fs::symlink_metadata(root.join(path)).unwrap().modified().unwrap()
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

    /// gix 的已跟踪比较结果（路径与状态），`preload` 时只比较预检剩下的子集。
    fn tracked(root: &Path, preload: bool) -> (Vec<String>, Outcome) {
        let repo = crate::status::open_with_excludes(root).unwrap();
        let index = repo.index_or_empty().unwrap();
        let mut outcome = Outcome::default();
        let worktree_index: gix::worktree::IndexPersistedOrInMemory = if preload {
            // 门槛设低，让小测试仓库也走到 fstatat 那条路径
            let settings = Settings { dense: 4, ..Settings::of(&repo).unwrap() };
            let (rest, done) = unresolved(&index, root, settings, 3).expect("非稀疏索引");
            outcome = done;
            gix::index::File::from_state(rest, repo.index_path()).into()
        } else {
            index.into()
        };
        let mut items: Vec<String> = repo
            .status(gix::progress::Discard)
            .unwrap()
            .index(worktree_index)
            .untracked_files(gix::status::UntrackedFiles::None)
            .into_index_worktree_iter(Vec::new())
            .unwrap()
            .map(|item| match item.unwrap() {
                gix::status::index_worktree::Item::Modification { rela_path, status, .. } => {
                    use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
                    match status {
                        // 子模块里的改动由 gix 并行产出，顺序不定：排序后再比
                        EntryStatus::Change(Change::SubmoduleModification(mut submodule)) => {
                            let mut changes: Vec<String> = submodule
                                .changes
                                .take()
                                .unwrap_or_default()
                                .iter()
                                .map(|change| format!("{change:?}"))
                                .collect();
                            changes.sort();
                            format!("{rela_path} SubmoduleModification({submodule:?}, {changes:?})")
                        }
                        status => format!("{rela_path} {status:?}"),
                    }
                }
                other => format!("{other:?}"),
            })
            // NeedsUpdate 只是「stat 该刷新了」，gix 不把它当改动（status 里也不出现）
            .filter(|item| !item.contains("NeedsUpdate"))
            .collect();
        items.sort();
        (items, outcome)
    }

    /// git 认为工作区一侧有改动的已跟踪路径（porcelain v2 的 `1` / `2` 记录 Y 位与 `u` 记录）。
    fn git_worktree_changes(root: &Path) -> Vec<String> {
        let out = git(root, &["--no-optional-locks", "status", "--porcelain=2", "-z", "--untracked-files=no"]);
        let mut paths = Vec::new();
        let mut records = out.split('\0');
        while let Some(record) = records.next() {
            let fields: Vec<&str> = record.splitn(9, ' ').collect();
            match fields.first() {
                Some(&"1") if fields[1].as_bytes()[1] != b'.' => paths.push(fields[8].to_string()),
                Some(&"2") => {
                    let fields: Vec<&str> = record.splitn(10, ' ').collect();
                    if fields[1].as_bytes()[1] != b'.' {
                        paths.push(fields[9].to_string());
                    }
                    records.next();
                }
                Some(&"u") => paths.push(record.splitn(11, ' ').nth(10).unwrap().to_string()),
                _ => {}
            }
        }
        paths.sort();
        paths
    }

    fn json(status: &crate::status::RepoStatus) -> String {
        serde_json::to_string(status).unwrap()
    }

    /// 预检与否 gix 的结论相同、与 git 的工作区一侧相同，`status` 的结果也相同；返回预检的情况。
    fn check(root: &Path, step: &str) -> Outcome {
        let (with, outcome) = tracked(root, true);
        let (without, _) = tracked(root, false);
        assert_eq!(with, without, "{step}: 预检改变了 gix 的结论（{outcome:?}）");
        let mut paths: Vec<String> = with.iter().map(|item| item.split(' ').next().unwrap().to_string()).collect();
        paths.dedup();
        // core.checkStat=minimal 时 git 不比 ctime，gix 仍比 ctime 的秒数（stat 不符就读内容），能发现 git
        // 发现不了的同 size 同 mtime 改写；这是 gix 原有的差异，预检保持 gix 的结论，这里不与 git 比。
        let minimal = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["config", "core.checkStat"])
            .output()
            .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == "minimal");
        if !minimal {
            assert_eq!(paths, git_worktree_changes(root), "{step}: 与 git 不同：{with:?}");
        }
        let tuned = crate::status::status_tuned(root, crate::status::Tuning::default()).map(|s| json(&s));
        let plain = crate::status::status_tuned(
            root,
            crate::status::Tuning { preload: false, cache_tree: false, share_dir_stats: false },
        )
        .map(|s| json(&s));
        assert_eq!(tuned, plain, "{step}: status 结果因加速而不同");
        outcome
    }

    /// 一个目录里 20 个文件（走 fstatat）和几个零散目录（走完整路径 lstat）。
    fn base(root: &Path) {
        for i in 0..20 {
            write(root, &format!("dense/f{i}.txt"), format!("dense {i}\n").as_bytes());
        }
        for path in ["top.txt", "a/one.txt", "a/b/two.txt", "a/b/c/three.txt", "x/y.txt", "empty.txt"] {
            write(root, path, if path == "empty.txt" { b"" } else { b"content\n" });
        }
        git(root, &["add", "-A"]);
        git(root, &["commit", "-qm", "base"]);
    }

    /// 让工作区文件的 mtime 落在索引时间戳之前好几秒并刷新索引，之后的 stat 比较不会 racy。
    fn age(root: &Path) {
        let past = SystemTime::now() - Duration::from_secs(30);
        for line in git(root, &["ls-files", "-z"]).split('\0').filter(|l| !l.is_empty()) {
            if std::fs::symlink_metadata(root.join(line)).is_ok_and(|m| m.file_type().is_file()) {
                set_mtime(root, line, past);
            }
        }
        let _ = Command::new("git").arg("-C").arg(root).args(["update-index", "-q", "--really-refresh"]).output();
    }

    #[test]
    fn 预检_干净的工作区全部判定为没变() {
        let (_d, root) = init();
        base(&root);
        age(&root);
        let outcome = check(&root, "干净");
        assert_eq!(outcome.marked, 26, "所有文件都应由预检判定：{outcome:?}");
    }

    #[test]
    fn 预检_racy_写入交给_gix_读内容() {
        let (_d, root) = init();
        base(&root);
        age(&root);
        // 把 mtime 设到索引时间戳之后再 add：这两个条目在索引里是 racy 的
        let future = SystemTime::now() + Duration::from_secs(5);
        for path in ["dense/f3.txt", "a/b/two.txt"] {
            set_mtime(&root, path, future);
        }
        git(&root, &["add", "-A"]);
        git(&root, &["config", "core.trustctime", "false"]);
        check(&root, "racy 但没改");
        // 同 size 改写并把 mtime 改回：不看 ctime 时 stat 完全相符，只有 racy 判定能发现
        for path in ["dense/f3.txt", "a/b/two.txt"] {
            let mut content = std::fs::read(root.join(path)).unwrap();
            content[0] ^= 0x20;
            std::fs::write(root.join(path), &content).unwrap();
            set_mtime(&root, path, future);
        }
        let (items, outcome) = tracked(&root, true);
        assert!(items.iter().any(|i| i.starts_with("dense/f3.txt ")), "racy 改写应被发现：{items:?}");
        assert!(items.iter().any(|i| i.starts_with("a/b/two.txt ")), "racy 改写应被发现：{items:?}");
        assert!(outcome.marked >= 20, "其余条目仍由预检判定：{outcome:?}");
        check(&root, "racy 改写");
    }

    #[test]
    fn 预检_同_size_同_mtime_改写靠_ctime_发现() {
        let (_d, root) = init();
        base(&root);
        age(&root);
        // 刷新索引时记下的 ctime 只比到秒（gix 与 git 默认都不看纳秒）：等过这一秒，改写后的 ctime 才不同
        std::thread::sleep(Duration::from_millis(1100));
        for path in ["dense/f7.txt", "x/y.txt"] {
            let old = mtime(&root, path);
            let mut content = std::fs::read(root.join(path)).unwrap();
            content[0] ^= 0x20;
            std::fs::write(root.join(path), &content).unwrap();
            set_mtime(&root, path, old);
        }
        let (items, _) = tracked(&root, true);
        assert_eq!(items.len(), 2, "ctime 变了，两处改写都应发现：{items:?}");
        check(&root, "trustctime 开");
        // 不信任 ctime 时 git 自己也看不出来：两边一致地报告没变
        git(&root, &["config", "core.trustctime", "false"]);
        let outcome = check(&root, "trustctime 关");
        assert_eq!(outcome.marked, 26, "{outcome:?}");
        git(&root, &["config", "--unset", "core.trustctime"]);
        git(&root, &["config", "core.checkStat", "minimal"]);
        check(&root, "checkStat minimal");
    }

    #[test]
    fn 预检_assume_unchanged_skip_worktree_与_intent_to_add() {
        let (_d, root) = init();
        base(&root);
        age(&root);
        write(&root, "dense/f1.txt", b"changed but assumed\n");
        git(&root, &["update-index", "--assume-unchanged", "dense/f1.txt"]);
        write(&root, "a/one.txt", b"changed but skipped\n");
        git(&root, &["update-index", "--skip-worktree", "a/one.txt"]);
        std::fs::remove_file(root.join("dense/f2.txt")).unwrap();
        git(&root, &["update-index", "--skip-worktree", "dense/f2.txt"]);
        write(&root, "dense/new.txt", b"intent\n");
        write(&root, "ita-empty.txt", b"");
        git(&root, &["add", "-N", "dense/new.txt", "ita-empty.txt"]);
        let (items, _) = tracked(&root, true);
        assert!(items.iter().any(|i| i.starts_with("dense/new.txt ") && i.contains("IntentToAdd")), "{items:?}");
        check(&root, "标记位");
    }

    #[test]
    fn 预检_可执行位与类型变化() {
        use std::os::unix::fs::PermissionsExt;
        let (_d, root) = init();
        base(&root);
        age(&root);
        std::fs::set_permissions(root.join("dense/f4.txt"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_file(root.join("a/b/two.txt")).unwrap();
        std::fs::create_dir(root.join("a/b/two.txt")).unwrap();
        std::fs::remove_file(root.join("top.txt")).unwrap();
        std::os::unix::fs::symlink("dense/f5.txt", root.join("top.txt")).unwrap();
        std::fs::remove_file(root.join("dense/f6.txt")).unwrap();
        check(&root, "chmod、文件变目录、文件变链接、删除");
        git(&root, &["config", "core.fileMode", "false"]);
        check(&root, "fileMode 关");
        git(&root, &["config", "core.symlinks", "false"]);
        check(&root, "symlinks 关");
    }

    #[test]
    fn 预检_路径上的符号链接不当作原目录() {
        let (_d, root) = init();
        base(&root);
        age(&root);
        // 把目录挪走、原处换成指向它的链接：完整路径 lstat 会穿过链接拿到同一个 inode 的 stat，
        // 和索引完全相符；git 与 gix 都认为这些路径已被删除。
        std::fs::rename(root.join("dense"), root.join("moved")).unwrap();
        std::os::unix::fs::symlink("moved", root.join("dense")).unwrap();
        std::fs::rename(root.join("a/b"), root.join("a/b-moved")).unwrap();
        std::os::unix::fs::symlink("b-moved", root.join("a/b")).unwrap();
        let (items, _) = tracked(&root, true);
        assert_eq!(items.iter().filter(|i| i.contains("Removed")).count(), 22, "{items:?}");
        check(&root, "路径上的符号链接");
    }

    #[test]
    fn 预检_已跟踪的符号链接() {
        let (_d, root) = init();
        write(&root, "target-a", b"a\n");
        write(&root, "target-b", b"b\n");
        std::os::unix::fs::symlink("target-a", root.join("link")).unwrap();
        std::fs::create_dir(root.join("dir")).unwrap();
        std::os::unix::fs::symlink("../target-a", root.join("dir/link")).unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-qm", "links"]);
        check(&root, "链接没变");
        std::fs::remove_file(root.join("link")).unwrap();
        // 同样长度的目标
        std::os::unix::fs::symlink("target-b", root.join("link")).unwrap();
        check(&root, "链接目标改了");
    }

    #[test]
    fn 预检_换行与过滤属性() {
        let (_d, root) = init();
        write(&root, ".gitattributes", b"*.txt text eol=crlf\n*.bin -text\n");
        for i in 0..20 {
            write(&root, &format!("dense/f{i}.txt"), b"line one\nline two\n");
        }
        write(&root, "data.bin", b"\x00\x01\r\n");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-qm", "attrs"]);
        // 重新检出：工作区里是 CRLF，与 blob 不同但没有改动
        for i in 0..20 {
            std::fs::remove_file(root.join(format!("dense/f{i}.txt"))).unwrap();
        }
        git(&root, &["checkout", "-q", "--", "."]);
        assert!(std::fs::read(root.join("dense/f0.txt")).unwrap().windows(2).any(|w| w == b"\r\n"));
        check(&root, "CRLF 检出（可能 racy）");
        age(&root);
        check(&root, "CRLF 检出");
        // 只改 mtime：stat 不符，gix 要按过滤后的内容比较，结论仍是没变
        set_mtime(&root, "dense/f9.txt", SystemTime::now() - Duration::from_secs(5));
        check(&root, "只改 mtime");
        write(&root, "dense/f10.txt", b"line one\r\nline 2!\r\n");
        check(&root, "真的改了");
        git(&root, &["config", "core.autocrlf", "true"]);
        check(&root, "autocrlf");
    }

    #[test]
    fn 预检_子模块与冲突() {
        let (_d, outer) = crate::test_repo::with_submodule();
        check(&outer, "子模块");

        let (_d, root) = init();
        base(&root);
        git(&root, &["switch", "-qc", "side"]);
        write(&root, "dense/f0.txt", b"side\n");
        git(&root, &["commit", "-qam", "side"]);
        git(&root, &["switch", "-q", "main"]);
        write(&root, "dense/f0.txt", b"main\n");
        git(&root, &["commit", "-qam", "main"]);
        let _ = Command::new("git").arg("-C").arg(&root).args(["merge", "-q", "side"]).output();
        let (items, _) = tracked(&root, true);
        assert!(items.iter().any(|i| i.starts_with("dense/f0.txt ") && i.contains("Conflict")), "{items:?}");
        check(&root, "冲突");
    }

    #[test]
    fn 预检_稀疏检出() {
        let (_d, root) = init();
        base(&root);
        git(&root, &["sparse-checkout", "set", "--no-cone", "/dense/", "/top.txt"]);
        assert!(!root.join("a").exists(), "稀疏检出应移走 a/");
        check(&root, "非 cone 稀疏检出");
        // 稀疏索引：索引里有目录条目，预检直接不做；加速与否的结果（含报错）相同
        git(&root, &["sparse-checkout", "set", "--cone", "--sparse-index", "dense"]);
        let repo = crate::status::open_with_excludes(&root).unwrap();
        let index = repo.index_or_empty().unwrap();
        assert!(index.is_sparse(), "应得到稀疏索引");
        assert!(unresolved(&index, &root, Settings::of(&repo).unwrap(), 2).is_none());
        let tuned = crate::status::status_tuned(&root, crate::status::Tuning::default()).map(|s| json(&s));
        let plain = crate::status::status_tuned(
            &root,
            crate::status::Tuning { preload: false, cache_tree: false, share_dir_stats: false },
        )
        .map(|s| json(&s));
        assert_eq!(tuned, plain, "稀疏索引：加速与否结果相同");
    }

    #[test]
    fn 预检_随机操作序列与_gix_和_git_一致() {
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let mut next = |n: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % n as u64) as usize
        };
        let (_d, root) = init();
        base(&root);
        age(&root);
        let files: Vec<String> =
            git(&root, &["ls-files", "-z"]).split('\0').filter(|l| !l.is_empty()).map(String::from).collect();
        let run = |args: &[&str]| {
            let _ = Command::new("git").arg("-C").arg(&root).args(args).output();
        };
        let mut marked = 0;
        for step in 0..120 {
            let file = &files[next(files.len())];
            let path = root.join(file);
            let description = match next(12) {
                0 | 1 => {
                    // 同 size 改写并保留 mtime
                    let old = std::fs::symlink_metadata(&path).and_then(|m| m.modified());
                    if let (Ok(old), Ok(mut content)) = (old, std::fs::read(&path)) {
                        if let Some(first) = content.first_mut() {
                            *first ^= 0x01;
                        }
                        let _ = std::fs::write(&path, &content);
                        let _ = std::fs::File::options().write(true).open(&path).and_then(|f| f.set_modified(old));
                    }
                    format!("同 size 改写 {file}")
                }
                2 => {
                    let appended = std::fs::OpenOptions::new().append(true).open(&path);
                    let _ = appended.map(|mut f| std::io::Write::write_all(&mut f, b"more\n"));
                    format!("追加 {file}")
                }
                3 => {
                    let _ = std::fs::remove_file(&path);
                    format!("删除 {file}")
                }
                4 => {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = if next(2) == 0 { 0o755 } else { 0o644 };
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode));
                    format!("chmod {mode:o} {file}")
                }
                5 => {
                    run(&["add", "-A"]);
                    "add -A".into()
                }
                6 => {
                    run(&["commit", "-qam", "step"]);
                    "commit".into()
                }
                7 => {
                    run(&["checkout", "-q", "--", "."]);
                    "checkout .".into()
                }
                8 => {
                    let flag = ["--assume-unchanged", "--no-assume-unchanged", "--skip-worktree", "--no-skip-worktree"]
                        [next(4)];
                    run(&["update-index", flag, "--", file]);
                    format!("update-index {flag} {file}")
                }
                9 => {
                    let key = ["core.trustctime", "core.fileMode", "core.checkStat"][next(3)];
                    let value = if key == "core.checkStat" {
                        ["default", "minimal"][next(2)]
                    } else {
                        ["true", "false"][next(2)]
                    };
                    run(&["config", key, value]);
                    format!("config {key}={value}")
                }
                10 => {
                    age(&root);
                    "刷新索引、mtime 推到过去".into()
                }
                _ => {
                    let dir = Path::new(file).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                    let meta = std::fs::symlink_metadata(root.join(&dir));
                    if !dir.is_empty() && meta.as_ref().is_ok_and(|m| m.is_dir()) {
                        let moved = format!("{dir}-moved");
                        let _ = std::fs::rename(root.join(&dir), root.join(&moved));
                        let name = Path::new(&moved).file_name().unwrap().to_owned();
                        let _ = std::os::unix::fs::symlink(name, root.join(&dir));
                        format!("{dir} 换成链接")
                    } else if !dir.is_empty() && meta.is_ok_and(|m| m.file_type().is_symlink()) {
                        let _ = std::fs::remove_file(root.join(&dir));
                        let _ = std::fs::rename(root.join(format!("{dir}-moved")), root.join(&dir));
                        format!("{dir} 换回目录")
                    } else {
                        "跳过".into()
                    }
                }
            };
            marked += check(&root, &format!("第 {step} 步：{description}")).marked;
        }
        assert!(marked > 1000, "预检应在多数步骤里判定大部分条目：{marked}");
    }

    /// 直接构造 stat 与工作区完全相符、不 racy 的条目：只有 gix 会直接判定「没变」的那种才能被预检拿走。
    /// intent-to-add、冲突的各个 stage、对象是空 blob 而 size 不为 0、工作区里是目录的条目，gix 都另有结论
    /// （IntentToAdd、Conflict、读内容比较、Removed / 子模块状态）；git 写不出 stat 与工作区相符的这类条目，
    /// 所以在这里单独构造。
    #[test]
    fn 预检_只拿走_gix_会直接放过的条目() {
        let (_d, root) = init();
        write(&root, "f.txt", b"content\n");
        std::fs::create_dir(root.join("sub")).unwrap();
        set_mtime(&root, "f.txt", SystemTime::now() - Duration::from_secs(30));
        git(&root, &["add", "f.txt"]);
        let repo = crate::status::open_with_excludes(&root).unwrap();
        let index = repo.index_or_empty().unwrap();
        let entry = index.entries()[0].clone();
        let stat_of = |path: &str| {
            let mut buf = Vec::new();
            assert!(c_path(&mut buf, &[root.as_os_str().as_encoded_bytes(), b"/", path.as_bytes()]));
            to_stat(&lstat(&buf).unwrap()).unwrap()
        };
        let empty_blob = gix::ObjectId::empty_blob(gix::hash::Kind::Sha1);
        let stage = |n: u32| Flags::from_bits_retain(n << 12);
        let cases: [(&str, &str, Flags, Mode, gix::ObjectId, bool); 10] = [
            ("普通条目", "f.txt", Flags::empty(), Mode::FILE, entry.id, true),
            ("intent-to-add", "f.txt", Flags::INTENT_TO_ADD | Flags::EXTENDED, Mode::FILE, entry.id, false),
            ("stage 1", "f.txt", stage(1), Mode::FILE, entry.id, false),
            ("stage 2", "f.txt", stage(2), Mode::FILE, entry.id, false),
            ("stage 3", "f.txt", stage(3), Mode::FILE, entry.id, false),
            ("空 blob 但 size 不为 0", "f.txt", Flags::empty(), Mode::FILE, empty_blob, false),
            ("可执行位不同", "f.txt", Flags::empty(), Mode::FILE_EXECUTABLE, entry.id, false),
            ("gitlink 指向目录", "sub", Flags::empty(), Mode::COMMIT, entry.id, false),
            ("文件条目、工作区是目录", "sub", Flags::empty(), Mode::FILE, entry.id, false),
            ("符号链接条目、工作区是文件", "f.txt", Flags::empty(), Mode::SYMLINK, entry.id, false),
        ];
        let settings = Settings { dense: usize::MAX, ..Settings::of(&repo).unwrap() };
        for (name, path, flags, mode, id, expected) in cases {
            for dense in [1, usize::MAX] {
                let mut state = gix::index::State::new(gix::hash::Kind::Sha1);
                state.set_timestamp(index.timestamp());
                state.dangerously_push_entry(stat_of(path), id, flags, mode, BStr::new(path));
                let (clean, _) = up_to_date_entries(&state, &root, Settings { dense, ..settings }, 1);
                assert_eq!(clean[0], expected, "{name}（dense {dense}）");
            }
        }
    }
}
