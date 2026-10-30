//! Native boundary for Desktop's shell environment collection. printenvz is
//! compiled verbatim from upstream and embedded, so packaged apps need no Node.
use serde::Deserialize;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;
pub fn context() -> serde_json::Value {
    let variables: std::collections::HashMap<_, _> =
        ["SHELL", "COMSPEC"].into_iter().filter_map(|k| std::env::var(k).ok().map(|v| (k, v))).collect();
    #[cfg(windows)]
    let install: Option<String> = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\GitForWindows")
        .ok()
        .and_then(|key| key.get_value("InstallPath").ok());
    #[cfg(not(windows))]
    let install: Option<String> = None;
    serde_json::json!({"variables":variables,"gitInstallPath":install})
}
pub fn find_executable(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions: Vec<String> = if Path::new(name).extension().is_some() {
        vec![String::new()]
    } else {
        std::iter::once(String::new())
            .chain(
                std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into()).split(';').map(str::to_owned),
            )
            .collect()
    };
    #[cfg(not(windows))]
    let extensions = [String::new()];
    for directory in std::env::split_paths(&path) {
        for extension in &extensions {
            let candidate = directory.join(format!("{name}{extension}"));
            if !candidate.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if std::fs::metadata(&candidate).ok()?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}
// NamedTempFile's random name and private permissions prevent replacing a
// predictable helper in a shared temporary directory. Keep it alive for the app.
static HELPER: std::sync::OnceLock<tempfile::TempPath> = std::sync::OnceLock::new();
static HELPER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub fn printenvz_path() -> std::io::Result<PathBuf> {
    let _lock = HELPER_LOCK.lock().map_err(|_| std::io::Error::other("printenvz lock poisoned"))?;
    if let Some(file) = HELPER.get() {
        return Ok(file.to_path_buf());
    }
    use std::io::Write;
    let mut file = tempfile::Builder::new()
        .prefix("gitcub-printenvz-")
        .suffix(if cfg!(windows) { ".exe" } else { "" })
        .tempfile()?;
    file.write_all(include_bytes!(env!("GITCUB_PRINTENVZ_PATH")))?;
    file.flush()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file().set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    let path = file.path().to_owned();
    let _ = HELPER.set(file.into_temp_path());
    Ok(path)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    pub shell: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub windows_verbatim_arguments: Option<bool>,
    pub argv0: Option<String>,
}
pub fn capture(options: CaptureOptions) -> Result<crate::process::ProcessOutput, crate::process::ProcessError> {
    let mut command = std::process::Command::new(&options.shell);
    command.env_clear();
    if let Some(cwd) = options.cwd {
        command.current_dir(cwd);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        if let Some(argv0) = options.argv0 {
            command.arg0(argv0);
        }
        let _ = options.windows_verbatim_arguments;
        command.args(options.args);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if options.windows_verbatim_arguments == Some(true) {
            // Rust quotes the actual executable as argv[0]. A Git Bash path with
            // spaces therefore remains intact for MSYS2; remaining args are raw.
            for arg in options.args {
                command.raw_arg(arg);
            }
        } else {
            command.args(options.args);
        }
        let _ = options.argv0;
    }
    crate::process::execute_command(command, 120_000, 16 * 1024 * 1024)
}
