//! Known Windows integration executables; never execute imported shell commands.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub fn available() -> Vec<Value> {
    discover(|key| std::env::var_os(key).map(PathBuf::from))
}

fn discover(env: impl Fn(&str) -> Option<PathBuf>) -> Vec<Value> {
    let mut apps = Vec::new();
    let candidates = [
        ("Visual Studio Code", "editor", "windows:vscode", "LOCALAPPDATA", "Programs/Microsoft VS Code/Code.exe"),
        ("Visual Studio Code", "editor", "windows:vscode", "ProgramFiles", "Microsoft VS Code/Code.exe"),
        (
            "Visual Studio Code (Insiders)",
            "editor",
            "windows:vscode-insiders",
            "LOCALAPPDATA",
            "Programs/Microsoft VS Code Insiders/Code - Insiders.exe",
        ),
        ("Cursor", "editor", "windows:cursor", "LOCALAPPDATA", "Programs/cursor/Cursor.exe"),
        ("Command Prompt", "terminal", "windows:cmd", "WINDIR", "System32/cmd.exe"),
        ("PowerShell", "terminal", "windows:powershell", "WINDIR", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ("PowerShell Core", "terminal", "windows:pwsh", "ProgramFiles", "PowerShell/7/pwsh.exe"),
        ("Windows Terminal", "terminal", "windows:terminal", "LOCALAPPDATA", "Microsoft/WindowsApps/wt.exe"),
        ("Git Bash", "terminal", "windows:git-bash", "ProgramFiles", "Git/git-bash.exe"),
    ];
    for (name, kind, id, base, suffix) in candidates {
        if let Some(root) = env(base) {
            let path = root.join(suffix);
            if path.is_file() && !apps.iter().any(|app: &Value| app["bundleId"] == id) {
                apps.push(json!({"name":name,"kind":kind,"bundleId":id,"path":path}));
            }
        }
    }
    apps
}

pub fn open(id: &str, directory: &Path) -> Result<(), String> {
    let apps = available();
    let app = apps.iter().find(|app| app["bundleId"] == id).ok_or("Selected Windows application is unavailable")?;
    let executable = app["path"].as_str().ok_or("Missing Windows application path")?;
    let mut command = std::process::Command::new(executable);
    command.current_dir(directory);
    match id {
        "windows:terminal" => {
            command.arg("-d").arg(directory);
        }
        "windows:powershell" | "windows:pwsh" => {
            command.arg("-NoExit");
        }
        "windows:git-bash" => {
            command.arg(format!("--cd={}", directory.display()));
        }
        "windows:cmd" => {}
        _ if app["kind"] == "editor" => {
            command.arg(directory);
        }
        _ => return Err("Unsupported Windows integration".into()),
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if matches!(id, "windows:cmd" | "windows:powershell" | "windows:pwsh") {
            command.creation_flags(0x00000010); // CREATE_NEW_CONSOLE
        }
    }
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_installed_executables_are_offered_and_precedence_is_stable() {
        let temp = tempfile::tempdir().unwrap();
        for suffix in ["Programs/Microsoft VS Code/Code.exe", "Microsoft VS Code/Code.exe", "System32/cmd.exe"] {
            let path = temp.path().join(suffix);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, []).unwrap();
        }
        let apps = discover(|_| Some(temp.path().to_path_buf()));
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0]["bundleId"], "windows:vscode");
        assert!(apps[0]["path"].as_str().unwrap().contains("Programs"));
        assert_eq!(apps[1]["bundleId"], "windows:cmd");
        assert!(discover(|_| None).is_empty());
    }
}
