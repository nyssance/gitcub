//! 所有 git 调用的唯一入口。
//!
//! 散在各处的 `Command::new("git")` 收敛到这里，为的是：
//!   - 环境清理只写一遍（TERM、locale、凭据配置）
//!   - 将来换成 Tauri sidecar 打包的 git 只改一处
//!   - 参数与错误处理一致
//!
//! 环境变量的设置照搬 GitHub Desktop 的 `withTrampolineEnv`
//! （app/src/lib/trampoline/trampoline-environment.ts）和
//! `core.ts` 里 exec 的 env，注释中标注了各自的理由。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;

/// 随应用打包的 git 安装目录；没有就用 PATH 上的 git。
///
/// 二进制来自 desktop/dugite-native（GitHub Desktop 用的同一个源），
/// 由 script/download-git.py 下载并剥掉 Git Credential Manager。
/// 打包后约 41MB。
///
/// 打包的意义：不依赖用户装没装 git，也不受其 git 版本影响——
/// 我们用了 `-z`、`--patch-with-raw`、`--unidiff-zero` 这些参数，
/// 老版本上行为可能不一致。
static BUNDLED: OnceLock<Option<PathBuf>> = OnceLock::new();

/// 由 main 在启动时调用，把 Tauri 的资源目录告诉这里。
pub fn set_resource_dir(dir: &Path) {
    let key = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", _) => "darwin-x64",
        ("windows", "aarch64") => "win32-arm64",
        _ => "win32-x64",
    };
    let root = dir.join("git").join(key);
    let _ = BUNDLED.set(executable(&root).is_file().then_some(root));
}

/// dugite `getWin32GitSubfolder`：Windows 包里 git 的 MSYS2 子目录。
fn win32_subfolder() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "ucrt64",
        "aarch64" => "clangarm64",
        _ => "mingw32",
    }
}

/// dugite `resolveGitBinary`：Windows 是 `cmd\git.exe`，其它平台 `bin/git`。
fn executable(root: &Path) -> PathBuf {
    if cfg!(windows) { root.join("cmd").join("git.exe") } else { root.join("bin").join("git") }
}

/// dugite `resolveGitExecPath`：Windows 在子目录下的 `libexec/git-core`。
fn exec_path(root: &Path) -> PathBuf {
    let base = if cfg!(windows) { root.join(win32_subfolder()) } else { root.to_path_buf() };
    base.join("libexec").join("git-core")
}

fn bundled() -> Option<&'static PathBuf> {
    BUNDLED.get().and_then(|o| o.as_ref())
}

/// 打包的 git（没打包时为 PATH 上的 git）；钩子代理用它跑 `git hook run`（原版 resolveGitBinary）
pub fn binary() -> PathBuf {
    bundled().map(|root| executable(root)).unwrap_or_else(|| PathBuf::from("git"))
}

/// 打包的 git 读的系统级配置（`GIT_CONFIG_SYSTEM`）；用 PATH 上的 git 时为 `None`。
/// 进程内快速路径据此判断 gix 读到的系统配置是不是 git 实际会读的那份。
pub fn bundled_system_config() -> Option<PathBuf> {
    bundled().filter(|_| !cfg!(windows)).map(|root| root.join("etc").join("gitconfig"))
}

/// 一次 git 调用。
pub struct Git {
    cmd: Command,
    stdin: Option<String>,
}

/// 把若干 `key=value` 组装成 GIT_CONFIG_PARAMETERS 的值。
///
/// 用这个而不是 `-c key=value` 参数，是因为**参数不会传给 filter 进程**
/// （典型如 Git LFS），而环境变量会。凭据配置必须让 LFS 也能拿到，
/// 否则带 LFS 的仓库认证会失败。
///
/// 也不用文档化的 GIT_CONFIG_{COUNT,KEY,VALUE}：Windows 上有 Python 写的
/// hook 管理器处理不了其中的空值。见 desktop/desktop#18945。
fn config_parameters(pairs: &[&str]) -> String {
    pairs.iter().map(|p| format!("'{}'", p.replace('\'', r"'\''"))).collect::<Vec<_>>().join(" ")
}

const REPOSITORY_LOCATION_ENV: [&str; 9] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
];

impl Git {
    /// 在 `repo` 里跑 git。传 `None` 表示不限定工作目录。
    pub fn new(repo: Option<&Path>) -> Self {
        let mut cmd = match bundled() {
            Some(root) => {
                let mut c = Command::new(executable(root));
                // 环境设置照搬 dugite 的 setupEnvironment（lib/git-environment.ts）
                if cfg!(windows) {
                    // 子目录的 bin 与 usr\bin 放到 PATH 最前面，git 调起的 sh、ssh 等用包里的
                    let sub = root.join(win32_subfolder());
                    let mut paths = vec![sub.join("bin"), sub.join("usr").join("bin")];
                    paths.extend(
                        std::env::var_os("PATH")
                            .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
                            .unwrap_or_default(),
                    );
                    if let Ok(joined) = std::env::join_paths(paths) {
                        c.env("PATH", joined);
                    }
                }
                c.env("GIT_EXEC_PATH", exec_path(root));
                if !cfg!(windows) {
                    // macOS 的 /etc/gitconfig 是系统级的、我们改不了，
                    // 指向发行包自带的那份，让用户的 global/local 配置仍能覆盖
                    c.env("GIT_CONFIG_SYSTEM", root.join("etc").join("gitconfig"));
                    // 初始化仓库时用来填充 .git 的模板
                    c.env("GIT_TEMPLATE_DIR", root.join("share/git-core/templates"));
                }
                c
            }
            // 没打包（开发时）或找不到，退回 PATH 上的 git
            None => Command::new("git"),
        };
        if let Some(r) = repo {
            cmd.arg("-C").arg(r);
        }
        // 从终端、git hook 或另一个 git 进程里启动时，环境里可能带着别的仓库位置；
        // 不清掉的话 `-C` 指定的仓库会被它们盖住（git environment.c `local_repo_env` 中的位置变量）。
        // 需要临时 index 的调用方在这之后再设 GIT_INDEX_FILE。
        for key in REPOSITORY_LOCATION_ENV {
            cmd.env_remove(key);
        }

        cmd
            // 显式设成 dumb：否则从终端启动、或系统里有 TERM 时，
            // git 会把我们当成智能终端（影响 editor/pager 行为）。
            // 见 git 的 editor.c L11-L15。
            .env("TERM", "dumb")
            // 认证失败就报错，不要回落到 tty 交互把界面卡死
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ADVICE", "0");

        Self { cmd, stdin: None }
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        self.cmd.args(args);
        self
    }

    pub fn arg(mut self, arg: impl AsRef<std::ffi::OsStr>) -> Self {
        self.cmd.arg(arg);
        self
    }

    pub fn env(mut self, k: impl AsRef<std::ffi::OsStr>, v: impl AsRef<std::ffi::OsStr>) -> Self {
        self.cmd.env(k, v);
        self
    }

    /// 有 token 就接我们的 askpass，没有就保持 git 原样。
    ///
    /// SSH 远端、本地路径远端、以及用户自己配好的 credential helper 都不需要
    /// 我们插手；硬要一个 token 只会把这些本来能推的场景变成「未认证」。
    /// （GIT_TERMINAL_PROMPT=0 已在 Git::new 里设好，真缺凭据时 git 直接报错，
    /// 不会卡住等输入。）
    pub fn with_optional_token(self, token: Option<&str>, user: Option<&str>) -> Self {
        match token {
            Some(t) => self.with_token(t, user),
            None => self,
        }
    }

    /// 接入凭据：清空系统 credential helper 链，改用我们自己的 askpass。
    ///
    /// 清空链有两个作用：不读系统钥匙串里可能过期的凭据，
    /// 也不会把这次用的 token 顺手存进去。
    pub fn with_token(mut self, token: &str, user: Option<&str>) -> Self {
        let exe = std::env::current_exe().unwrap_or_default();
        self.cmd
            .env("GIT_ASKPASS", exe)
            .env("GITCUB_ASKPASS_TOKEN", token)
            .env("GIT_CONFIG_PARAMETERS", config_parameters(&["credential.helper="]));
        if let Some(u) = user {
            self.cmd.env("GITCUB_ASKPASS_USER", u);
        }
        self
    }

    /// 往 stdin 写内容（`git apply -` 这类用）。
    pub fn stdin(mut self, data: impl Into<String>) -> Self {
        self.stdin = Some(data.into());
        self
    }

    pub fn output(mut self) -> Result<Output, String> {
        match self.stdin.take() {
            None => self.cmd.output().map_err(started),
            Some(data) => {
                self.cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
                let mut child = self.cmd.spawn().map_err(started)?;
                child
                    .stdin
                    .take()
                    .ok_or("拿不到 git 的 stdin")?
                    .write_all(data.as_bytes())
                    .map_err(|e| format!("写 stdin 失败: {e}"))?;
                child.wait_with_output().map_err(|e| format!("等待 git 失败: {e}"))
            }
        }
    }

    /// Capture raw output while emitting terminal-rendered output as the child runs.
    pub fn output_stream(self, on_output: impl FnMut(TerminalChunk)) -> Result<Output, String> {
        self.stream_output(true, on_output)
    }

    pub fn output_raw_stream(self, on_output: impl FnMut(TerminalChunk)) -> Result<Output, String> {
        self.stream_output(false, on_output)
    }

    fn stream_output(mut self, render: bool, mut on_output: impl FnMut(TerminalChunk)) -> Result<Output, String> {
        use std::io::Read;
        self.cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = self.cmd.spawn().map_err(started)?;
        let stdout = child.stdout.take().ok_or("Missing Git stdout")?;
        let stderr = child.stderr.take().ok_or("Missing Git stderr")?;
        let stdin = child.stdin.take().ok_or("Missing Git stdin")?;
        let data = self.stdin.take();
        let writer = std::thread::spawn(move || {
            let mut stdin = stdin;
            if let Some(data) = data { stdin.write_all(data.as_bytes()) } else { Ok(()) }
        });
        let (sender, receiver) = std::sync::mpsc::channel();
        let read_pipe = |mut reader: Box<dyn Read + Send>,
                         sender: std::sync::mpsc::Sender<TerminalChunk>,
                         stream: TerminalStream| {
            std::thread::spawn(move || -> Result<Vec<u8>, String> {
                let mut raw = Vec::new();
                let mut terminal = crate::terminal::Terminal::default();
                let mut chunk = [0; 8192];
                loop {
                    let count = reader.read(&mut chunk).map_err(|e| e.to_string())?;
                    if count == 0 {
                        break;
                    }
                    raw.extend_from_slice(&chunk[..count]);
                    let rendered = if render { terminal.push(&chunk[..count]) } else { chunk[..count].to_vec() };
                    if !rendered.is_empty() {
                        sender.send(TerminalChunk { stream, bytes: rendered }).map_err(|e| e.to_string())?;
                    }
                }
                let remaining = terminal.finish();
                if !remaining.is_empty() {
                    sender.send(TerminalChunk { stream, bytes: remaining }).map_err(|e| e.to_string())?;
                }
                Ok(raw)
            })
        };
        let out_reader = read_pipe(Box::new(stdout), sender.clone(), TerminalStream::Stdout);
        let err_reader = read_pipe(Box::new(stderr), sender, TerminalStream::Stderr);
        for chunk in receiver {
            on_output(chunk);
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let stdout = out_reader.join().map_err(|_| "Git stdout reader panicked")??;
        let stderr = err_reader.join().map_err(|_| "Git stderr reader panicked")??;
        let written = writer.join().map_err(|_| "Git stdin writer panicked")?;
        if status.success() {
            written.map_err(|e| e.to_string())?;
        }
        Ok(Output { status, stdout, stderr })
    }

    /// Read at most `limit` bytes and reap the process after an intentional cut-off.
    /// Blob previews must not buffer a multi-gigabyte object just to show its header.
    pub fn output_prefix(mut self, limit: usize) -> Result<(Output, bool), String> {
        use std::io::Read;
        if self.stdin.is_some() {
            return Err("Prefix reads do not accept stdin".into());
        }
        self.cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = self.cmd.spawn().map_err(started)?;
        let stderr = child.stderr.take().ok_or("Missing Git stderr")?;
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = std::io::BufReader::new(stderr).read_to_end(&mut bytes);
            result.map(|_| bytes)
        });
        let mut stdout = Vec::new();
        let read = child.stdout.take().ok_or("Missing Git stdout")?.take(limit as u64).read_to_end(&mut stdout);
        let truncated = stdout.len() == limit;
        if truncated || read.is_err() {
            let _ = child.kill();
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let stderr = reader.join().map_err(|_| "Git stderr reader panicked")?.map_err(|e| e.to_string())?;
        read.map_err(|e| e.to_string())?;
        Ok((Output { status, stdout, stderr }, truncated))
    }

    /// Execute with Desktop's explicit accepted exit-code and error sets.
    pub fn execute(self, repo: &Path, codes: &[i32], errors: &[String]) -> Result<ExecutionResult, String> {
        let out = self.output()?;
        checked_result(repo, out, codes, errors)
    }

    /// 跑完并要求成功，返回 stdout。
    pub fn stdout(self) -> Result<String, String> {
        self.execute(Path::new("."), &[0], &[]).map(|result| result.stdout)
    }

    /// 跑完并要求成功，丢弃输出。
    pub fn run(self) -> Result<(), String> {
        self.stdout().map(|_| ())
    }

    /// 跑完，成功与否都只返回 stdout（失败时为空）。
    /// 用于「拿不到就算了」的查询，比如读某个 config。
    pub fn stdout_or_empty(self) -> String {
        self.output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    }
}

fn started(e: std::io::Error) -> String {
    format!("启动 git 失败（PATH 里有 git 吗？）: {e}")
}

/// 失败时给用户看的那句话。
///
/// 不能只看 stderr：有些命令把要紧的话写在 stdout（`git merge` 冲突时那句
/// `CONFLICT (content): ...` / `Automatic merge failed` 就在 stdout，stderr 是空的，
/// 实测表现为「报了个空错误」）。两边都空就退回退出码，至少不是无声失败。
pub fn stderr_of(out: &Output) -> String {
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !err.is_empty() {
        return err;
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    match out.status.code() {
        Some(code) => format!("git 以退出码 {code} 结束"),
        None => "git 被信号中断".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 随包 git 的布局照 dugite git-environment.ts：Windows 的 git.exe 在 cmd 下，
    /// exec path 在 MSYS2 子目录下；没有 bin\git.exe，按旧路径找会退回 PATH 上的 git。
    #[test]
    fn 随包_git_布局与_dugite_一致() {
        let root = Path::new("git-root");
        if cfg!(windows) {
            assert_eq!(executable(root), root.join("cmd").join("git.exe"));
            assert_eq!(exec_path(root), root.join(win32_subfolder()).join("libexec").join("git-core"));
        } else {
            assert_eq!(executable(root), root.join("bin").join("git"));
            assert_eq!(exec_path(root), root.join("libexec").join("git-core"));
        }
    }

    /// GitLens env.gitDir：继承来的 GIT_DIR 等不能盖住 `-C` 指定的仓库。
    /// 改进程环境会和并行测试互相干扰，所以检查子进程环境里这些变量被显式移除。
    #[test]
    fn 不继承别的仓库位置() {
        let git = Git::new(Some(Path::new("/tmp")));
        let removed: Vec<_> = git.cmd.get_envs().filter(|(_, value)| value.is_none()).map(|(key, _)| key).collect();
        for key in REPOSITORY_LOCATION_ENV {
            assert!(removed.contains(&std::ffi::OsStr::new(key)), "{key} 应被移除");
        }
        let index = Git::new(None).env("GIT_INDEX_FILE", "/tmp/index");
        assert!(index.cmd.get_envs().any(|(key, value)| key == "GIT_INDEX_FILE" && value.is_some()));
    }

    /// 用一个必然失败、且把话写在 stdout 的命令来验
    #[test]
    fn 失败信息在_stdout_时也要报出来() {
        let d = tempfile::tempdir().unwrap();
        let out = Git::new(Some(d.path())).args(["merge", "nonexistent-branch"]).output().unwrap();
        assert!(!out.status.success());
        assert!(!stderr_of(&out).is_empty(), "不能报空错误");
    }

    #[test]
    fn config_parameters_的引号格式() {
        assert_eq!(config_parameters(&["credential.helper="]), "'credential.helper='");
        assert_eq!(config_parameters(&["a=1", "b=2"]), "'a=1' 'b=2'", "多个参数空格分隔");
    }

    #[test]
    fn 值里的单引号要转义() {
        // shell 风格转义：' → '\''
        assert_eq!(config_parameters(&["k=it's"]), r"'k=it'\''s'");
    }

    #[test]
    fn 能跑起来并拿到版本号() {
        let out = Git::new(None).args(["--version"]).stdout().unwrap();
        assert!(out.starts_with("git version"), "实际: {out}");
    }
}

/// Structured execution result shared by native callers and the conformance adapter.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionResult {
    pub path: PathBuf,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub git_error: Option<&'static str>,
    pub git_error_description: Option<String>,
}

/// Error categories consumed by Desktop's Git workflows. Unknown errors remain failures.
pub fn classify_error(output: &str) -> Option<&'static str> {
    if output.contains("fatal: bad revision ") {
        Some("BadRevision")
    } else if output
        .lines()
        .any(|line| line.starts_with("error: could not lock config file ") && line.ends_with(": File exists"))
    {
        Some("ConfigLockFileAlreadyExists")
    } else if output.contains("Your local changes to the following files would be overwritten by merge:") {
        Some("MergeWithLocalChanges")
    } else if output.contains("cannot pull with rebase:") || output.contains("cannot rebase:") {
        Some("RebaseWithLocalChanges")
    } else if output.contains("Your local changes to the following files would be overwritten by checkout:") {
        Some("LocalChangesOverwritten")
    } else if output.contains("CONFLICT (") || output.contains("Automatic merge failed;") {
        Some("MergeConflicts")
    } else {
        None
    }
}

pub fn config_lock_path(repo: &Path, stderr: &str) -> Option<PathBuf> {
    let config = stderr
        .lines()
        .find_map(|line| line.strip_prefix("error: could not lock config file ")?.strip_suffix(": File exists"))?;
    let normalized = if cfg!(windows) { config.replace('/', "\\") } else { config.to_string() };
    let path = repo.join(format!("{normalized}.lock"));
    std::path::absolute(path).ok()
}

pub fn checked_result(repo: &Path, out: Output, codes: &[i32], errors: &[String]) -> Result<ExecutionResult, String> {
    let accepted_code = out.status.code().is_some_and(|code| codes.contains(&code));
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let git_error = if accepted_code { None } else { classify_error(&stderr).or_else(|| classify_error(&stdout)) };
    if !accepted_code && !git_error.is_some_and(|kind| errors.iter().any(|expected| expected == kind)) {
        return Err(stderr_of(&out));
    }
    Ok(ExecutionResult {
        path: repo.to_path_buf(),
        exit_code: out.status.code(),
        stdout,
        stderr,
        git_error,
        git_error_description: None,
    })
}

/// Preserve pipe identity so interleaved UTF-8 sequences cannot corrupt each other.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalStream {
    Stdout,
    Stderr,
}
#[derive(Clone, serde::Serialize)]
pub struct TerminalChunk {
    pub stream: TerminalStream,
    pub bytes: Vec<u8>,
}
