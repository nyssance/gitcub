//! Desktop's Cygwin launch contract: directory data goes through the environment,
//! never into the shell program. The same plan is executed by the native command.
use serde::Serialize;
use std::path::Path;
#[derive(Serialize)]
pub struct LaunchPlan {
    pub executable: String,
    pub args: [String; 3],
    pub cwd: String,
    pub env: std::collections::HashMap<String, String>,
}
pub fn plan(executable: &str, path: &str) -> LaunchPlan {
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    env.insert("GITHUB_DESKTOP_CYGWIN_OPEN_PATH".into(), path.into());
    LaunchPlan {
        executable: executable.into(),
        args: [
            "/bin/sh".into(),
            "-lc".into(),
            r#"cd -- "$(cygpath -- "$GITHUB_DESKTOP_CYGWIN_OPEN_PATH")" && exec bash"#.into(),
        ],
        cwd: path.into(),
        env,
    }
}
pub fn launch(executable: &Path, path: &Path) -> Result<u32, String> {
    let plan = plan(&executable.to_string_lossy(), &path.to_string_lossy());
    let mut command = std::process::Command::new(plan.executable);
    command.args(plan.args).current_dir(plan.cwd).envs(plan.env);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}
