//! 文件监听 —— 工作区被别人改了，界面自己就该更新。
//!
//! 为什么要做：原版（GitHub Desktop）根本不监听文件，它只在窗口重新获得焦点
//! 时刷新。单屏来回切窗口时这够用，但在宽屏上把客户端和编辑器并排摆着是常态：
//! 你在编辑器里保存，客户端从头到尾没失去过焦点，于是那份列表一直是旧的。
//! 构建、`npm install`、另一个终端里的 git 操作同理。所以这一条不照抄原版。
//!
//! 两个难点，处理办法写在下面：
//!   1. 事件是**暴风雨**式的：保存一次文件可能来好几条，一次 `cargo build`
//!      能来上万条。→ 攒一批、安静下来再发一次（防抖）。
//!   2. `.git` 里大部分动静与界面无关（objects/、各种 .lock）。
//!      → 只认那几个真会改变界面的路径。
//!   3. 被 .gitignore 忽略的路径（target/、node_modules/）改了不影响状态。
//!      → 问 gix 一次，按顶层目录缓存答案。

use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 前端据此刷新。事件负载是仓库路径——万一监听已经切走了，前端可以对一下。
pub const EVENT: &str = "repo-changed";

/// 安静这么久就算一批结束。太短会在保存一次文件时刷好几遍，
/// 太长则手感上「改完要等一下才出现」。
const QUIET: Duration = Duration::from_millis(400);
/// 一直有动静时最多攒这么久就先发一次，否则跑着构建的那几分钟里界面是死的。
const MAX_WAIT: Duration = Duration::from_secs(2);

/// `.git` 下会改变界面的那些路径。其余（objects/、logs/、各种 .lock）一律不理。
///
/// `index.lock` 尤其要滤掉：git 的每个写操作都会造一个再删掉，跟着它刷新
/// 等于每次 git 操作多刷两遍，而紧随其后的 `index` 变化已经能代表这件事了。
///
/// `config`（链接工作树另有 `config.worktree`）要认：上游、远端与 pull.rebase 都从这里读，
/// 在应用外 `git branch --set-upstream-to`、`git remote set-url` 之后状态不能停在旧值。
fn git_dir_matters(rel: &Path) -> bool {
    let s = rel.to_string_lossy();
    if s.ends_with(".lock") {
        return false;
    }
    matches!(
        s.as_ref(),
        "HEAD"
            | "index"
            | "config"
            | "config.worktree"
            | "packed-refs"
            | "MERGE_HEAD"
            | "MERGE_MSG"
            | "ORIG_HEAD"
            | "CHERRY_PICK_HEAD"
            | "REVERT_HEAD"
            | "REBASE_HEAD"
    ) || s.starts_with("refs/")
        || s.starts_with("rebase-merge")
        || s.starts_with("rebase-apply")
}

/// 这条路径的改动值不值得刷新。
fn matters(repo: &Path, path: &Path, ignored: &mut HashMap<PathBuf, bool>) -> bool {
    let Ok(rel) = path.strip_prefix(repo) else {
        return false;
    };
    let mut parts = rel.components();
    match parts.next() {
        None => false,
        Some(Component::Normal(first)) if first == ".git" => git_dir_matters(&parts.collect::<PathBuf>()),
        // 顶层目录被忽略（target/、node_modules/）就整棵不理。按顶层缓存：
        // 一次构建的上万条事件只会真正问 gix 一次。
        Some(Component::Normal(first)) => {
            let top = PathBuf::from(first);
            let hit = ignored.get(&top).copied();
            let is_ignored = match hit {
                Some(v) => v,
                None => {
                    let v = ignored_by_git(repo, &top);
                    ignored.insert(top, v);
                    v
                }
            };
            !is_ignored
        }
        Some(_) => false,
    }
}

/// 问 gix：这个路径被 .gitignore 挡掉了吗。
///
/// 只对顶层目录问，问不出来就当成「没被忽略」——宁可多刷一次，
/// 也不要因为判断失误把真实改动吞掉。
pub(crate) fn ignored_by_git(repo: &Path, rel: &Path) -> bool {
    excluded(repo, rel, repo.join(rel).is_dir())
}

/// gix 的忽略判定本体；`is_dir` 决定只对目录生效的规则（`build/`）算不算数。
pub(crate) fn excluded(repo: &Path, rel: &Path, is_dir: bool) -> bool {
    let Ok(r) = crate::status::open_with_excludes(repo) else { return false };
    let Ok(index) = r.index_or_empty() else {
        return false;
    };
    let Ok(mut stack) =
        r.excludes(&index, None, gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped)
    else {
        return false;
    };
    let mode = if is_dir { gix::index::entry::Mode::DIR } else { gix::index::entry::Mode::FILE };
    stack.at_entry(rel, Some(mode)).ok().and_then(|p| p.excluded_kind()).is_some()
}

/// 正在监听的那一个仓库。切仓库时旧的直接丢掉（Drop 里自动停）。
#[derive(Default)]
pub struct Watching(pub Mutex<Option<Handle>>);

pub struct Handle {
    pub repo: PathBuf,
    /// 丢掉它就等于停掉监听：发送端一没，工作线程收到 Disconnected 自行退出。
    /// None = 目录让出去了，见 [`Watching::release`]。
    #[cfg_attr(not(any(windows, test)), expect(dead_code, reason = "只靠 Drop 停监听"))]
    watcher: Option<RecommendedWatcher>,
    /// 让出去之后目录没了（被改名或挪走），等它回来再盯。
    #[cfg(any(windows, test))]
    lost: bool,
}

/// Windows 上 `ReadDirectoryChangesW` 要一直拿着仓库目录的句柄，拿着的时候这个文件夹
/// 在资源管理器里改不了名、挪不走（原版不监听目录，没有这个限制）。资源管理器到前台时
/// 把句柄放掉，离开时再盯上并补一次刷新：改名挪动照常，其余时间的实时刷新也还在。
#[cfg(any(windows, test))]
impl Watching {
    /// 放掉目录句柄，记住是哪个仓库。
    fn release(&self) {
        if let Some(handle) = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_mut() {
            handle.watcher = None;
        }
    }

    /// 重新盯上让出去的仓库。返回需要通知前端刷新的仓库：刚盯回来（让出期间的变化没收到），
    /// 或者目录没了（前端据此显示「找不到仓库」）。目录没了之后只等它重新出现，不反复通知。
    fn resume(&self, start: impl FnOnce(&Path) -> Result<RecommendedWatcher, String>) -> Option<PathBuf> {
        let mut slot = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let handle = slot.as_mut().filter(|handle| handle.watcher.is_none())?;
        if handle.lost && !handle.repo.is_dir() {
            return None;
        }
        match start(&handle.repo) {
            Ok(watcher) => {
                handle.watcher = Some(watcher);
                handle.lost = false;
                Some(handle.repo.clone())
            }
            Err(error) => {
                log::warn!("重新监听 {} 失败: {error}", handle.repo.display());
                let first = !std::mem::replace(&mut handle.lost, true);
                first.then(|| handle.repo.clone())
            }
        }
    }
}

/// 资源管理器在前台时让出仓库目录，见 [`Watching::release`]。
#[cfg(windows)]
pub fn yield_to_explorer(app: AppHandle) {
    use tauri::Manager as _;
    std::thread::spawn(move || {
        let mut last = (0, false);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let state = app.state::<Watching>();
            if state.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_none() {
                continue;
            }
            if explorer_in_foreground(&mut last) {
                state.release();
            } else if let Some(repo) = state.resume(|repo| start(&app, repo)) {
                emit_change(&app, &repo);
            }
        }
    });
}

/// 前台窗口是不是资源管理器的（文件夹窗口、桌面、任务栏都算）。`last` 记上一次查过的进程，
/// 前台没换就不再开进程句柄。
#[cfg(windows)]
fn explorer_in_foreground(last: &mut (u32, bool)) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid)) };
    if pid == 0 {
        return false;
    }
    if last.0 == pid {
        return last.1;
    }
    let explorer = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.is_ok_and(|process| {
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let named = unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
        }
        .is_ok();
        let _ = unsafe { CloseHandle(process) };
        named
            && String::from_utf16_lossy(&buffer[..length as usize])
                .rsplit('\\')
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("explorer.exe"))
    });
    *last = (pid, explorer);
    explorer
}

/// 开始监听 `repo`，替换掉上一个。
pub fn watch(app: &AppHandle, repo: &Path, state: &Watching) -> Result<(), String> {
    let mut slot = state.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if slot.as_ref().is_some_and(|h| h.repo == repo) {
        return Ok(());
    }
    // 先把旧的放掉，免得两个监听同时往前端发
    *slot = None;
    let watcher = start(app, repo)?;
    *slot = Some(Handle {
        repo: repo.to_path_buf(),
        watcher: Some(watcher),
        #[cfg(any(windows, test))]
        lost: false,
    });
    Ok(())
}

/// 建立对 `repo` 的监听并起好事件泵；丢掉返回值就停。
fn start(app: &AppHandle, repo: &Path) -> Result<RecommendedWatcher, String> {
    let (app, event_repo) = (app.clone(), repo.to_path_buf());
    start_with(repo, move || emit_change(&app, &event_repo))
}

fn start_with(repo: &Path, changed: impl Fn() + Send + 'static) -> Result<RecommendedWatcher, String> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        match res {
            // 发送失败 = 接收端没了，说明已经切走，忽略即可
            Ok(ev) => {
                let _ = tx.send(ev);
            }
            Err(error) => log::warn!("文件监听出错: {error}"),
        }
    })
    .map_err(|e| format!("建立文件监听失败: {e}"))?;
    let root = std::fs::canonicalize(repo).map_err(|e| e.to_string())?;
    // Use the same path spelling for registration and event filtering. On macOS
    // /var and /private/var (or a user symlink) can name the same repository.
    // Canonicalizing only the filter silently discards every lexical-path event.
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| format!("监听 {} 失败: {e}", repo.display()))?;
    let git_dirs = git_directories(&root)?;
    for directory in &git_dirs {
        if !directory.starts_with(&root)
            && !git_dirs.iter().any(|other| other != directory && directory.starts_with(other))
        {
            watcher.watch(directory, RecursiveMode::Recursive).map_err(|e| format!("监听 Git 元数据失败: {e}"))?;
        }
    }
    std::thread::spawn(move || pump(changed, root, git_dirs, rx));
    Ok(watcher)
}

/// 收事件、防抖、发通知。仓库被切走时发送端一丢，这里自然退出。
fn emit_change(app: &AppHandle, repo: &Path) {
    if let Err(error) = app.emit(EVENT, repo.to_string_lossy()) {
        log::warn!("通知 {} 工作区变化失败: {error}", repo.display());
    }
}

fn pump(changed: impl Fn(), repo: PathBuf, git_dirs: Vec<PathBuf>, rx: mpsc::Receiver<notify::Event>) {
    let mut ignored: HashMap<PathBuf, bool> = HashMap::new();
    let mut pending = false;
    let mut first: Option<Instant> = None;

    loop {
        match rx.recv_timeout(QUIET) {
            Ok(ev) => {
                if ev.paths.iter().any(|p| event_matters(&repo, &git_dirs, p, &mut ignored)) {
                    pending = true;
                    first.get_or_insert_with(Instant::now);
                }
                // 一直有动静也不能一直不发
                if pending && first.is_some_and(|t| t.elapsed() >= MAX_WAIT) {
                    changed();
                    pending = false;
                    first = None;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if pending {
                    changed();
                    pending = false;
                    first = None;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

// A linked worktree keeps HEAD/index outside its working directory.
fn git_directories(repo: &Path) -> Result<Vec<PathBuf>, String> {
    let git = gix::open(repo).map_err(|e| e.to_string())?;
    let mut dirs = vec![git.git_dir(), git.common_dir()]
        .into_iter()
        .map(std::fs::canonicalize)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    dirs.sort();
    dirs.dedup();
    Ok(dirs)
}
fn event_matters(repo: &Path, git_dirs: &[PathBuf], path: &Path, ignored: &mut HashMap<PathBuf, bool>) -> bool {
    if path.file_name().is_some_and(|name| name == ".gitignore") {
        ignored.clear();
        return true;
    }
    for directory in git_dirs {
        if let Ok(relative) = path.strip_prefix(directory) {
            if relative == Path::new("info/exclude") || relative == Path::new("index") {
                ignored.clear();
                return true;
            }
            if git_dir_matters(relative) {
                return true;
            }
        }
    }
    matters(repo, path, ignored)
}

/// 给测试用：不经过 Tauri，直接验「哪些路径值得刷新」这条规则。
#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn watching_large_trees_does_not_open_every_file_or_break_git() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..2000 {
            std::fs::write(directory.path().join(format!("artifact-{index}")), "build output").unwrap();
        }
        let descriptors = || std::fs::read_dir("/dev/fd").unwrap().count();
        let before = descriptors();
        let mut watcher = notify::recommended_watcher(|_: notify::Result<notify::Event>| {}).unwrap();
        watcher.watch(directory.path(), RecursiveMode::Recursive).unwrap();
        assert!(descriptors() < before + 100, "recursive watching must not hold one descriptor per file");
        assert!(crate::git::Git::new(None).args(["--version"]).output().unwrap().status.success());
    }

    fn yielded(repo: &Path) -> (Watching, mpsc::Receiver<()>, impl Fn(&Path) -> Result<RecommendedWatcher, String>) {
        gix::init(repo).unwrap();
        let (tx, rx) = mpsc::channel();
        let start = move |repo: &Path| {
            let tx = tx.clone();
            start_with(repo, move || {
                let _ = tx.send(());
            })
        };
        let watching = Watching(Mutex::new(Some(Handle {
            repo: repo.to_path_buf(),
            watcher: Some(start(repo).unwrap()),
            lost: false,
        })));
        watching.release();
        (watching, rx, start)
    }

    #[test]
    fn a_yielded_repository_is_watched_again_and_refreshed_once() {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let (watching, changes, start) = yielded(&repo);
        assert!(watching.0.lock().unwrap().as_ref().unwrap().watcher.is_none());
        // 让出期间没有监听：这次改动收不到，靠盯回来时的那一次通知补上
        std::fs::write(repo.join("while-yielded"), "").unwrap();
        assert!(changes.recv_timeout(QUIET * 3).is_err());
        assert_eq!(watching.resume(&start), Some(repo.clone()));
        assert_eq!(watching.resume(&start), None, "已经盯着就不再通知");
        std::fs::write(repo.join("after"), "").unwrap();
        changes.recv_timeout(Duration::from_secs(10)).expect("盯回来之后的改动照常通知");
    }

    #[test]
    fn a_repository_moved_while_yielded_is_reported_once_and_watched_when_it_returns() {
        let directory = tempfile::tempdir().unwrap();
        let (repo, moved) = (directory.path().join("repo"), directory.path().join("moved"));
        std::fs::create_dir(&repo).unwrap();
        let (watching, _changes, start) = yielded(&repo);
        std::fs::rename(&repo, &moved).unwrap();
        assert_eq!(watching.resume(&start), Some(repo.clone()), "目录没了要通知前端一次");
        assert_eq!(watching.resume(&start), None, "之后只等它回来");
        std::fs::rename(&moved, &repo).unwrap();
        assert_eq!(watching.resume(&start), Some(repo.clone()));
        assert!(watching.0.lock().unwrap().as_ref().unwrap().watcher.is_some());
    }

    #[test]
    fn 只认_git_目录里真会改变界面的那几个() {
        assert!(git_dir_matters(Path::new("HEAD")));
        assert!(git_dir_matters(Path::new("index")));
        assert!(git_dir_matters(Path::new("MERGE_HEAD")));
        assert!(git_dir_matters(Path::new("refs/heads/main")));
        assert!(git_dir_matters(Path::new("rebase-merge/done")));
        assert!(git_dir_matters(Path::new("config")));
        assert!(!git_dir_matters(Path::new("config.lock")));

        // git 每次写操作都会造一个再删掉的锁文件，跟着它刷等于白刷两遍
        assert!(!git_dir_matters(Path::new("index.lock")));
        assert!(!git_dir_matters(Path::new("refs/heads/main.lock")));
        assert!(!git_dir_matters(Path::new("objects/ab/cdef")));
        assert!(!git_dir_matters(Path::new("logs/HEAD")));
    }

    #[test]
    fn 被忽略的目录不触发刷新() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        let git = |args: &[&str]| {
            std::process::Command::new("git").arg("-C").arg(&r).args(args).output().unwrap();
        };
        git(&["init", "-q", "-b", "main", "."]);
        git(&["config", "user.email", "t@t.t"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(r.join(".gitignore"), "target/\n").unwrap();
        std::fs::create_dir_all(r.join("target/debug")).unwrap();
        std::fs::create_dir_all(r.join("src")).unwrap();
        std::fs::write(r.join("src/a.rs"), "x\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "init"]);

        let mut cache = HashMap::new();
        assert!(!matters(&r, &r.join("target/debug/gitcub"), &mut cache), "构建产物不该刷新");
        assert!(matters(&r, &r.join("src/a.rs"), &mut cache), "源码改了要刷新");
        assert!(matters(&r, &r.join("新文件.txt"), &mut cache), "新文件要刷新");
        assert!(matters(&r, &r.join(".git/HEAD"), &mut cache), "切分支要刷新");
        assert!(matters(&r, &r.join(".git/config"), &mut cache), "改上游、远端要刷新");
        assert!(!matters(&r, &r.join(".git/index.lock"), &mut cache), "锁文件不该刷新");
    }

    /// GitLens gitIgnoreFilter：相对的 core.excludesFile 跟 git 一样按仓库根目录找，不按进程工作目录。
    #[test]
    fn 相对的_excludes_file_挡住的目录不触发刷新() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        std::process::Command::new("git").arg("-C").arg(&r).args(["init", "-q", "-b", "main", "."]).output().unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(&r)
            .args(["config", "core.excludesFile", "rel-excludes"])
            .output()
            .unwrap();
        std::fs::write(r.join("rel-excludes"), "dist/\n").unwrap();
        std::fs::create_dir(r.join("dist")).unwrap();
        assert!(!matters(&r, &r.join("dist/bundle.js"), &mut HashMap::new()), "被 excludesFile 忽略的目录不该刷新");
    }
    #[test]
    fn linked_worktree_metadata_and_ignore_edits_trigger_refresh() {
        let root = tempfile::tempdir().unwrap();
        let main = root.path().join("main");
        let worktree = root.path().join("linked");
        std::fs::create_dir(&main).unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&main)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        };
        git(&["init", "-q", "-b", "main"]);
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-qm",
            "initial",
        ]);
        git(&["worktree", "add", "-b", "linked", worktree.to_str().unwrap()]);
        let worktree = std::fs::canonicalize(worktree).unwrap();
        let metadata = git_directories(&worktree).unwrap();
        let git_dir = std::fs::canonicalize(gix::open(&worktree).unwrap().git_dir()).unwrap();
        let mut ignored = HashMap::new();
        assert!(event_matters(&worktree, &metadata, &git_dir.join("index"), &mut ignored));
        assert!(event_matters(&worktree, &metadata, &git_dir.join("HEAD"), &mut ignored));
        assert!(!event_matters(&worktree, &metadata, &git_dir.join("index.lock"), &mut ignored));
        ignored.insert("generated".into(), true);
        assert!(event_matters(&worktree, &metadata, &worktree.join(".gitignore"), &mut ignored));
        assert!(ignored.is_empty());
    }
}
