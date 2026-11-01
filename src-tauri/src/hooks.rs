//! Desktop lib/hooks 的移植：with-hooks-env.ts、hooks-proxy.ts、get-repo-hooks.ts。
//!
//! 打开「从 shell 加载 Git 钩子环境变量」后，原版把仓库里要拦截的钩子换成 process-proxy
//! 可执行文件（`core.hooksPath` 指向临时目录），钩子被 git 调起时经本地连接回到应用，
//! 由应用用登录 shell 的环境跑 `git hook run`，同时报告进度、失败时问用户忽略还是中止。
//!
//! 本项目差异：代理不是单独打包的 process-proxy，而是一行 sh 脚本 exec 应用自身的
//! `--gitcub-hook-proxy` 模式（和 askpass 同一种短路），连接走临时目录里的 Unix socket。
//! shell 环境由前端照原版 get-shell-env.ts 取好再传进来。其余行为照原版。

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// 应用以钩子代理身份被拉起时的 argv[1]
pub const PROXY_ARG: &str = "--gitcub-hook-proxy";
#[cfg(unix)]
const SOCKET_ENV: &str = "GITCUB_HOOKS_SOCKET";
#[cfg(unix)]
const TOKEN_ENV: &str = "GITCUB_HOOKS_TOKEN";

// https://git-scm.com/docs/githooks
const KNOWN_HOOKS: [&str; 28] = [
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-receive",
    "update",
    "proc-receive",
    "post-receive",
    "post-update",
    "reference-transaction",
    "push-to-checkout",
    "pre-auto-gc",
    "post-rewrite",
    "sendemail-validate",
    "fsmonitor-watchman",
    "p4-changelist",
    "p4-prepare-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
    "post-index-change",
];

/// 这些钩子的退出码 git 本来就不看，失败了也不问用户
#[cfg(unix)]
const IGNORED_ON_FAILURE_HOOKS: [&str; 6] =
    ["post-applypatch", "post-commit", "post-checkout", "post-merge", "pre-auto-gc", "post-rewrite"];

/// 原版注释：这些是 Desktop 给自己的 git 设的，不该漏给用户钩子里调起的 git
#[cfg(unix)]
const EXCLUDED_ENV_VARS: [&str; 7] = [
    "GIT_SYSTEM_CONFIG",
    "GIT_EXEC_PATH",
    "GIT_TEMPLATE_DIR",
    "GIT_CONFIG_PARAMETERS",
    "GIT_ASKPASS",
    "GIT_SSH_COMMAND",
    "GIT_USER_AGENT",
];

/// 前端照 get-shell-env.ts 取到的 shell 环境；只有开了钩子环境、仓库里又有要拦截的钩子时才传
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksEnv {
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub failure: Option<ShellFailure>,
}

/// 原版 ShellEnvResult 的 failure（找不到 shell）与 getShellEnv 抛错两种情况
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ShellFailure {
    NotFound { shell_kind: Option<String> },
    Error,
}

/// 原版 HookProgress 与 onHookFailure，经 Tauri Channel 送到前端
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HookEvent {
    Progress { id: u64, hook_name: String, status: &'static str },
    Failure { id: u64, hook_name: String, terminal_output: Vec<u8> },
}

/// 原版 HookCallbackOptions：进度，以及失败时问用户（true 为忽略并继续）
pub trait HookCallbacks: Send + Sync {
    fn progress(&self, id: u64, hook_name: &str, status: &'static str);
    fn failure(&self, id: u64, hook_name: &str, terminal_output: &[u8]) -> bool;
}

/// 原版 getRepoHooks：仓库里实际存在、可执行、在 `filter` 里的已知钩子
pub fn repo_hooks(repo: &Path, filter: Option<&[String]>) -> Vec<String> {
    let configured = crate::git::Git::new(Some(repo))
        .args(["config", "-z", "--get", "core.hooksPath"])
        .stdout()
        .ok()
        .map(|value| value.split('\0').next().unwrap_or_default().to_string());
    let hooks_path = match configured {
        Some(path) => repo.join(path),
        None => match crate::git::Git::new(Some(repo)).args(["rev-parse", "--git-path", "hooks"]).stdout() {
            Ok(path) => repo.join(path.trim_end_matches(['\r', '\n'])),
            Err(_) => return Vec::new(),
        },
    };
    let Ok(entries) = std::fs::read_dir(&hooks_path) else {
        return Vec::new();
    };
    // 原版就是这么写的：带 `*` 时一个都不返回
    let match_all = filter.is_some_and(|filter| filter.iter().any(|hook| hook == "*"));
    let mut hooks = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let hook_name = file_name.strip_suffix(".exe").unwrap_or(&file_name).to_string();
        if match_all || filter.is_some_and(|filter| !filter.contains(&hook_name)) {
            continue;
        }
        if !KNOWN_HOOKS.contains(&hook_name.as_str()) {
            continue;
        }
        if cfg!(windows) || is_executable(&entry.path()) {
            hooks.push(hook_name);
        }
    }
    hooks
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // 原版 access(path, X_OK)
    unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
}

#[cfg(not(unix))]
fn is_executable(_: &Path) -> bool {
    true
}

/// 原版 withHooksEnv：没开钩子环境、没要拦截的钩子时原样调用 `run`；否则给它额外的环境变量，
/// 让 git 把钩子交给代理，`run` 返回后收掉代理与临时目录
#[cfg(unix)]
pub fn with_hooks_env<T>(
    repo: &Path, intercept: &[&str], hooks_env: Option<HooksEnv>, callbacks: Option<std::sync::Arc<dyn HookCallbacks>>,
    run: impl FnOnce(Vec<(String, String)>) -> Result<T, String>,
) -> Result<T, String> {
    let Some(hooks_env) = hooks_env else {
        return run(Vec::new());
    };
    let intercept = intercept.iter().map(|hook| hook.to_string()).collect::<Vec<_>>();
    let hooks = repo_hooks(repo, Some(&intercept));
    if hooks.is_empty() {
        return run(Vec::new());
    }
    proxy::serve(&hooks, hooks_env, callbacks, run)
}

#[cfg(not(unix))]
pub fn with_hooks_env<T>(
    _: &Path, _: &[&str], _: Option<HooksEnv>, _: Option<std::sync::Arc<dyn HookCallbacks>>,
    run: impl FnOnce(Vec<(String, String)>) -> Result<T, String>,
) -> Result<T, String> {
    run(Vec::new())
}

/// 钩子代理身份的入口：把这次钩子调用交给应用，退出码照应用说的
#[cfg(unix)]
pub fn proxy_if_invoked() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(PROXY_ARG) {
        return None;
    }
    Some(proxy::run_client(args.collect()))
}

#[cfg(not(unix))]
pub fn proxy_if_invoked() -> Option<i32> {
    None
}

#[cfg(unix)]
#[allow(unused_imports)] // The conformance and benchmark bridges include this module without the Tauri commands.
pub use proxy::{abort, resolve_failure, wait_for_failure};

#[cfg(not(unix))]
pub fn abort(_: u64) {}

#[cfg(not(unix))]
pub fn resolve_failure(_: u64, _: bool) {}

#[cfg(not(unix))]
pub fn wait_for_failure(_: u64, _: impl FnOnce() -> bool) -> bool {
    false
}

#[cfg(unix)]
mod proxy {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, LazyLock, Mutex, mpsc};
    use std::time::Instant;

    use serde::{Deserialize, Serialize};

    use super::*;

    const FRAME_STDERR: u8 = b'E';
    const FRAME_EXIT: u8 = b'X';

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    /// 等用户在 HookFailed 里选的那一个
    static FAILURES: LazyLock<Mutex<HashMap<u64, mpsc::Sender<bool>>>> = LazyLock::new(Default::default);
    /// 正在跑的钩子进程，HookProgress started 的 abort 用
    static RUNNING: LazyLock<Mutex<HashMap<u64, u32>>> = LazyLock::new(Default::default);

    /// 代理发回应用的一次钩子调用（原版 conn.getArgs / getEnv / getCwd / isStdinConnected）
    #[derive(Serialize, Deserialize)]
    pub(super) struct ProxyRequest {
        pub token: String,
        pub args: Vec<String>,
        pub cwd: String,
        pub env: HashMap<String, String>,
        pub stdin: bool,
    }

    pub fn resolve_failure(id: u64, ignore: bool) {
        if let Some(sender) = FAILURES.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            let _ = sender.send(ignore);
        }
    }

    pub fn abort(id: u64) {
        if let Some(pid) = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).get(&id).copied() {
            // 原版 AbortController 让 spawn 发 SIGTERM
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
    }

    /// 等 HookFailed 的回答；前端没了就当中止
    pub fn wait_for_failure(id: u64, ask: impl FnOnce() -> bool) -> bool {
        let (sender, receiver) = mpsc::channel();
        FAILURES.lock().unwrap_or_else(|e| e.into_inner()).insert(id, sender);
        if !ask() {
            FAILURES.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return false;
        }
        receiver.recv().unwrap_or(false)
    }

    fn token() -> String {
        use std::hash::{BuildHasher, Hasher};
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        hasher.write_u32(std::process::id());
        let first = hasher.finish();
        hasher.write_u64(first);
        format!("{first:016x}{:016x}", hasher.finish())
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', r"'\''"))
    }

    pub(super) fn serve<T>(
        hooks: &[String], hooks_env: HooksEnv, callbacks: Option<Arc<dyn HookCallbacks>>,
        run: impl FnOnce(Vec<(String, String)>) -> Result<T, String>,
    ) -> Result<T, String> {
        let dir = tempfile::Builder::new().prefix("desktop-git-hooks-").tempdir().map_err(|e| e.to_string())?;
        // macOS 的 $TMPDIR 很深，套接字路径会超过 sun_path 的 104 字节；套接字单独放进 /tmp 下的私有目录（0700）
        let socket_dir = tempfile::Builder::new().prefix("gitcub-").tempdir_in("/tmp").map_err(|e| e.to_string())?;
        let socket = socket_dir.path().join("s");
        let listener = UnixListener::bind(&socket).map_err(|e| e.to_string())?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        for hook in hooks {
            let path = dir.path().join(hook);
            let script = format!("#!/bin/sh\nexec {} {PROXY_ARG} \"$0\" \"$@\"\n", shell_quote(&exe.to_string_lossy()));
            std::fs::write(&path, script).map_err(|e| e.to_string())?;
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }

        let token = token();
        let stop = Arc::new(AtomicBool::new(false));
        let server = {
            let stop = stop.clone();
            let token = token.clone();
            let tmp_hooks_dir = dir.path().to_path_buf();
            std::thread::spawn(move || {
                for connection in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(connection) = connection else { continue };
                    if let Err(error) = handle(connection, &token, &tmp_hooks_dir, &hooks_env, callbacks.as_deref()) {
                        log::error!("hooks proxy failed: {error}");
                    }
                }
            })
        };

        // 原版：沿用已有的 GIT_CONFIG_PARAMETERS，再追加 core.hooksPath
        let existing = std::env::var("GIT_CONFIG_PARAMETERS").unwrap_or_default();
        let prefix = if existing.is_empty() { String::new() } else { format!("{existing} ") };
        let result = run(vec![
            (
                "GIT_CONFIG_PARAMETERS".into(),
                format!("{prefix}{}", shell_quote(&format!("core.hooksPath={}", dir.path().display()))),
            ),
            (SOCKET_ENV.into(), socket.to_string_lossy().into_owned()),
            (TOKEN_ENV.into(), token),
        ]);

        stop.store(true, Ordering::SeqCst);
        let _ = UnixStream::connect(&socket);
        let _ = server.join();
        drop(socket_dir);
        drop(dir);
        result
    }

    fn write_frame(connection: &mut UnixStream, kind: u8, data: &[u8]) -> std::io::Result<()> {
        connection.write_all(&[kind])?;
        connection.write_all(&(data.len() as u32).to_be_bytes())?;
        connection.write_all(data)
    }

    fn writeline(connection: &mut UnixStream, message: &str) -> std::io::Result<()> {
        write_frame(connection, FRAME_STDERR, format!("{message}\n").as_bytes())
    }

    fn exit(connection: &mut UnixStream, code: i32) -> std::io::Result<()> {
        write_frame(connection, FRAME_EXIT, &code.to_be_bytes())
    }

    /// 原版 ensureGitExecPathEnv：shell 环境里没有 GIT_EXEC_PATH 时，用 shell PATH 上的 git 补上
    fn ensure_git_exec_path(mut env: HashMap<String, String>) -> HashMap<String, String> {
        if env.contains_key("GIT_EXEC_PATH") {
            return env;
        }
        let Some(path) = env.get("PATH").or_else(|| env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v))
        else {
            return env;
        };
        let Some(git) = std::env::split_paths(path).map(|dir| dir.join("git")).find(|git| is_executable(git)) else {
            log::debug!("hooks: Failed to find system git in PATH");
            return env;
        };
        let output = std::process::Command::new(&git).arg("--exec-path").env_clear().envs(&env).output();
        if let Ok(output) = output.as_ref().map_err(|e| log::debug!("hooks: Failed to get GIT_EXEC_PATH from Git: {e}"))
            && output.status.success()
        {
            let exec_path = String::from_utf8_lossy(&output.stdout).trim_end_matches(['\r', '\n']).to_string();
            log::debug!("hooks: Setting GIT_EXEC_PATH from system git ({exec_path})");
            env.insert("GIT_EXEC_PATH".into(), exec_path);
        }
        env
    }

    /// 原版 createHooksProxy 返回的那个连接处理函数
    fn handle(
        connection: UnixStream, expected_token: &str, tmp_hooks_dir: &Path, hooks_env: &HooksEnv,
        callbacks: Option<&dyn HookCallbacks>,
    ) -> Result<(), String> {
        let start = Instant::now();
        let mut reader = BufReader::new(connection.try_clone().map_err(|e| e.to_string())?);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
        let request: ProxyRequest = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if request.token != expected_token {
            return Err("invalid hooks proxy token".into());
        }
        let mut connection = connection;
        let hook_path = request.args.first().cloned().unwrap_or_default();
        let hook_name = Path::new(&hook_path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);

        writeline(&mut connection, &format!("Running {hook_name} hook...")).map_err(|e| e.to_string())?;
        if let Some(callbacks) = callbacks {
            callbacks.progress(id, &hook_name, "started");
        }

        let safe_env = request
            .env
            .iter()
            .filter(|(key, _)| {
                (key.starts_with("GIT_") || key.starts_with("GITHEAD_")) && !EXCLUDED_ENV_VARS.contains(&key.as_str())
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<HashMap<_, _>>();

        let shell_env = match (&hooks_env.env, &hooks_env.failure) {
            (Some(env), _) => ensure_git_exec_path(env.clone()),
            (None, Some(ShellFailure::NotFound { shell_kind })) => {
                let mut message = format!("Failed to load shell environment for hook {hook_name}.");
                if let Some(kind) = shell_kind {
                    let friendly = match kind.as_str() {
                        "git-bash" => "Git Bash",
                        "pwsh" => "PowerShell Core",
                        "powershell" => "Windows PowerShell",
                        "cmd" => "Command Prompt",
                        other => other,
                    };
                    if kind == "git-bash" {
                        message.push_str(&format!(
                            "\n{friendly} not found. Please ensure Git for Windows is installed and added to your PATH."
                        ));
                    } else {
                        message.push_str(&format!("\n{friendly} not found. Please ensure it's installed and added to your PATH."));
                    }
                }
                message.push_str("\n\nConfigure the shell to use in Preferences > Git > Hooks.");
                let _ = writeline(&mut connection, &message);
                let _ = exit(&mut connection, 1);
                return Ok(());
            }
            // 原版 getShellEnv 抛错时代理直接以 1 退出
            _ => {
                let _ = exit(&mut connection, 1);
                return Err("failed to load shell environment".into());
            }
        };

        // 代理先把 stdin 整个发完再收尾写端，和原版先缓冲到文件一样
        let mut stdin = Vec::new();
        reader.read_to_end(&mut stdin).map_err(|e| e.to_string())?;
        let stdin_path = request.stdin.then(|| tmp_hooks_dir.join(format!("{hook_name}-{}.stdin", &token()[..8])));
        if let Some(path) = &stdin_path
            && let Err(error) = std::fs::write(path, &stdin)
        {
            let _ = writeline(&mut connection, &format!("Failed to buffer stdin for {hook_name} hook: {error}"));
            let _ = exit(&mut connection, 1);
            if let Some(callbacks) = callbacks {
                callbacks.progress(id, &hook_name, "failed");
            }
            return Ok(());
        }

        let mut args = vec!["hook".to_string(), "run".into(), hook_name.clone()];
        if hook_name == "pre-auto-gc" {
            args.push("--ignore-missing".into());
        }
        if let Some(path) = &stdin_path {
            args.push(format!("--to-stdin={}", path.display()));
        }
        args.push("--".into());
        args.extend(request.args.iter().skip(1).cloned());

        let mut child = std::process::Command::new(crate::git::binary())
            .args(&args)
            .current_dir(&request.cwd)
            .env_clear()
            .envs(&shell_env)
            .envs(&safe_env)
            .env("GITHUB_DESKTOP", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        RUNNING.lock().unwrap_or_else(|e| e.into_inner()).insert(id, child.id());
        let mut terminal_output = Vec::new();
        if let Some(mut stderr) = child.stderr.take() {
            let mut chunk = [0; 8192];
            while let Ok(count) = stderr.read(&mut chunk) {
                if count == 0 {
                    break;
                }
                let _ = write_frame(&mut connection, FRAME_STDERR, &chunk[..count]);
                terminal_output.extend_from_slice(&chunk[..count]);
            }
        }
        let status = child.wait().map_err(|e| e.to_string());
        RUNNING.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        let status = status?;

        use std::os::unix::process::ExitStatusExt;
        let duration = format!("after {:.2}s", start.elapsed().as_secs_f64());
        let prefix = format!("{hook_name} hook");
        let code = status.code();
        let termination_message = match status.signal() {
            Some(signal) => format!("{prefix} killed by signal {} {duration}", signal_name(signal)),
            None => match code {
                Some(code) if code != 0 => format!("{prefix} failed with code {code} {duration}"),
                _ => format!("{prefix} done {duration}"),
            },
        };
        log::debug!("hooks: {termination_message}");
        terminal_output.extend_from_slice(format!("{termination_message}\n").as_bytes());

        let ignore_error = match (code, callbacks) {
            (Some(code), Some(callbacks)) if code != 0 && !IGNORED_ON_FAILURE_HOOKS.contains(&hook_name.as_str()) => {
                callbacks.failure(id, &hook_name, &terminal_output)
            }
            _ => false,
        };
        let _ = writeline(&mut connection, &termination_message);
        if ignore_error {
            let _ = writeline(&mut connection, &format!("{hook_name} hook failure ignored by user"));
        }
        let exit_code = if ignore_error { 0 } else { code.unwrap_or(1) };
        let _ = exit(&mut connection, exit_code);
        if let Some(callbacks) = callbacks {
            callbacks.progress(id, &hook_name, if exit_code == 0 { "finished" } else { "failed" });
        }
        Ok(())
    }

    fn signal_name(signal: i32) -> String {
        match signal {
            libc::SIGTERM => "SIGTERM".into(),
            libc::SIGKILL => "SIGKILL".into(),
            libc::SIGINT => "SIGINT".into(),
            libc::SIGHUP => "SIGHUP".into(),
            libc::SIGABRT => "SIGABRT".into(),
            libc::SIGSEGV => "SIGSEGV".into(),
            libc::SIGPIPE => "SIGPIPE".into(),
            other => other.to_string(),
        }
    }

    /// 原版 process-proxy 的客户端一侧：把参数、环境、工作目录和 stdin 交给应用，回放 stderr，按应用给的码退出
    pub(super) fn proxy(socket: &Path, request: &ProxyRequest, stdin: Option<&mut dyn Read>, stderr: &mut dyn Write) -> i32 {
        let Ok(mut connection) = UnixStream::connect(socket) else {
            return 1;
        };
        let Ok(mut header) = serde_json::to_vec(request) else {
            return 1;
        };
        header.push(b'\n');
        if connection.write_all(&header).is_err() {
            return 1;
        }
        if let Some(stdin) = stdin
            && std::io::copy(stdin, &mut connection).is_err()
        {
            return 1;
        }
        let _ = connection.shutdown(std::net::Shutdown::Write);
        loop {
            let mut kind = [0; 1];
            let mut length = [0; 4];
            if connection.read_exact(&mut kind).is_err() || connection.read_exact(&mut length).is_err() {
                return 1;
            }
            let mut data = vec![0; u32::from_be_bytes(length) as usize];
            if connection.read_exact(&mut data).is_err() {
                return 1;
            }
            match kind[0] {
                FRAME_STDERR => {
                    let _ = stderr.write_all(&data);
                    let _ = stderr.flush();
                }
                FRAME_EXIT => return data.try_into().map(i32::from_be_bytes).unwrap_or(1),
                _ => return 1,
            }
        }
    }

    pub(super) fn run_client(args: Vec<String>) -> i32 {
        let (Ok(socket), Ok(token)) = (std::env::var(SOCKET_ENV), std::env::var(TOKEN_ENV)) else {
            return 1;
        };
        let cwd = std::env::current_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
        // 原版 isStdinConnected：git 不给钩子输入时 stdin 是 /dev/null
        let stdin_connected = {
            use std::os::fd::AsFd;
            use std::os::unix::fs::FileTypeExt;
            std::io::stdin()
                .as_fd()
                .try_clone_to_owned()
                .ok()
                .map(std::fs::File::from)
                .and_then(|file| file.metadata().ok())
                .is_some_and(|meta| {
                    let kind = meta.file_type();
                    kind.is_fifo() || kind.is_socket() || kind.is_file()
                })
        };
        let request = ProxyRequest { token, args, cwd, env: std::env::vars().collect(), stdin: stdin_connected };
        let mut stdin = std::io::stdin().lock();
        let stdin: Option<&mut dyn Read> = if stdin_connected { Some(&mut stdin) } else { None };
        proxy(&PathBuf::from(socket), &request, stdin, &mut std::io::stderr().lock())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct Recorder {
            events: Mutex<Vec<String>>,
            ignore: bool,
        }

        impl HookCallbacks for Recorder {
            fn progress(&self, _: u64, hook_name: &str, status: &'static str) {
                self.events.lock().unwrap().push(format!("{hook_name} {status}"));
            }
            fn failure(&self, _: u64, hook_name: &str, terminal_output: &[u8]) -> bool {
                self.events.lock().unwrap().push(format!("{hook_name} asked: {}", String::from_utf8_lossy(terminal_output)));
                self.ignore
            }
        }

        fn repo_with_hook(name: &str, body: &str) -> tempfile::TempDir {
            let dir = tempfile::tempdir().unwrap();
            std::process::Command::new("git").args(["init", "-q"]).current_dir(dir.path()).status().unwrap();
            let hook = dir.path().join(".git/hooks").join(name);
            std::fs::write(&hook, body).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
            dir
        }

        fn shell_env() -> HooksEnv {
            let mut env = std::env::vars().filter(|(k, _)| k == "PATH" || k == "HOME").collect::<HashMap<_, _>>();
            env.insert("FROM_SHELL".into(), "loaded".into());
            HooksEnv { env: Some(env), failure: None }
        }

        /// 不经 git，直接以代理身份回连：钩子在 shell 环境里跑、stderr 回放、进度与失败询问按原版顺序
        fn invoke(repo: &Path, hook: &str, callbacks: Arc<Recorder>, hooks_env: HooksEnv) -> (i32, String) {
            serve(&[hook.to_string()], hooks_env, Some(callbacks), |env| {
                let env = env.into_iter().collect::<HashMap<_, _>>();
                let mut request_env = std::env::vars().collect::<HashMap<_, _>>();
                request_env.insert("GIT_INDEX_FILE".into(), ".git/index".into());
                request_env.insert("GIT_CONFIG_PARAMETERS".into(), env["GIT_CONFIG_PARAMETERS"].clone());
                let request = ProxyRequest {
                    token: env[TOKEN_ENV].clone(),
                    args: vec![format!("/tmp/x/{hook}"), "message-file".into()],
                    cwd: repo.to_string_lossy().into_owned(),
                    env: request_env,
                    stdin: false,
                };
                let mut stderr = Vec::new();
                let code = proxy(Path::new(&env[SOCKET_ENV]), &request, None, &mut stderr);
                Ok((code, String::from_utf8_lossy(&stderr).into_owned()))
            })
            .unwrap()
        }

        #[test]
        fn hook_runs_with_shell_env_and_reports_progress() {
            let repo = repo_with_hook(
                "commit-msg",
                "#!/bin/sh\necho \"shell=$FROM_SHELL desktop=$GITHUB_DESKTOP arg=$1 params=${GIT_CONFIG_PARAMETERS:-none}\" >&2\n",
            );
            let callbacks = Arc::new(Recorder { events: Mutex::default(), ignore: false });
            let (code, stderr) = invoke(repo.path(), "commit-msg", callbacks.clone(), shell_env());
            assert_eq!(code, 0, "{stderr}");
            assert!(stderr.starts_with("Running commit-msg hook...\n"), "{stderr}");
            assert!(stderr.contains("shell=loaded desktop=1 arg=message-file params=none"), "{stderr}");
            assert!(stderr.contains("commit-msg hook done after "), "{stderr}");
            assert_eq!(*callbacks.events.lock().unwrap(), ["commit-msg started", "commit-msg finished"]);
        }

        #[test]
        fn failed_hook_asks_and_can_be_ignored() {
            let repo = repo_with_hook("pre-commit", "#!/bin/sh\necho nope >&2\nexit 3\n");
            let abort = Arc::new(Recorder { events: Mutex::default(), ignore: false });
            let (code, stderr) = invoke(repo.path(), "pre-commit", abort.clone(), shell_env());
            assert_eq!(code, 3);
            assert!(stderr.contains("pre-commit hook failed with code 3 after "), "{stderr}");
            let events = abort.events.lock().unwrap().clone();
            assert_eq!(events[0], "pre-commit started");
            assert!(events[1].starts_with("pre-commit asked: nope\npre-commit hook failed with code 3"), "{events:?}");
            assert_eq!(events[2], "pre-commit failed");

            let ignore = Arc::new(Recorder { events: Mutex::default(), ignore: true });
            let (code, stderr) = invoke(repo.path(), "pre-commit", ignore.clone(), shell_env());
            assert_eq!(code, 0);
            assert!(stderr.ends_with("pre-commit hook failure ignored by user\n"), "{stderr}");
            assert_eq!(ignore.events.lock().unwrap().last().unwrap(), "pre-commit finished");
        }

        #[test]
        fn post_commit_failure_is_not_asked() {
            let repo = repo_with_hook("post-commit", "#!/bin/sh\nexit 1\n");
            let callbacks = Arc::new(Recorder { events: Mutex::default(), ignore: true });
            let (code, _) = invoke(repo.path(), "post-commit", callbacks.clone(), shell_env());
            assert_eq!(code, 1);
            assert_eq!(*callbacks.events.lock().unwrap(), ["post-commit started", "post-commit failed"]);
        }

        #[test]
        fn missing_shell_explains_where_to_configure_it() {
            let repo = repo_with_hook("pre-commit", "#!/bin/sh\nexit 0\n");
            let callbacks = Arc::new(Recorder { events: Mutex::default(), ignore: false });
            let failure = HooksEnv { env: None, failure: Some(ShellFailure::NotFound { shell_kind: None }) };
            let (code, stderr) = invoke(repo.path(), "pre-commit", callbacks, failure);
            assert_eq!(code, 1);
            assert!(stderr.contains("Failed to load shell environment for hook pre-commit."), "{stderr}");
            assert!(stderr.contains("Configure the shell to use in Preferences > Git > Hooks."), "{stderr}");
        }

        #[test]
        fn repo_hooks_lists_only_executable_known_hooks_in_filter() {
            let repo = repo_with_hook("pre-commit", "#!/bin/sh\n");
            let hooks = repo.path().join(".git/hooks");
            std::fs::write(hooks.join("commit-msg"), "#!/bin/sh\n").unwrap();
            std::fs::write(hooks.join("not-a-hook"), "#!/bin/sh\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(hooks.join("not-a-hook"), std::fs::Permissions::from_mode(0o755)).unwrap();
            let filter = ["pre-commit".to_string(), "commit-msg".into(), "not-a-hook".into()];
            assert_eq!(repo_hooks(repo.path(), Some(&filter)), ["pre-commit"]);
            assert!(repo_hooks(repo.path(), Some(&["post-commit".to_string()])).is_empty());
        }
    }
}
