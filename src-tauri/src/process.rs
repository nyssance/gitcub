//! Shell-free process execution with bounded output and a hard deadline.
use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

#[derive(Serialize)]
pub struct ProcessOutput {
    pub stdout: String,
    pub stderr: String,
}
#[derive(Serialize)]
pub struct ProcessError {
    pub message: String,
    pub code: Box<serde_json::Value>,
    pub stdout: String,
    pub stderr: String,
    pub killed: bool,
    pub signal: Option<&'static str>,
}
impl From<std::io::Error> for ProcessError {
    fn from(error: std::io::Error) -> Self {
        Self {
            message: error.to_string(),
            code: Box::new(serde_json::json!(match error.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => "EIO",
            })),
            stdout: String::new(),
            stderr: String::new(),
            killed: false,
            signal: None,
        }
    }
}
fn capture(mut pipe: impl Read, limit: usize, exceeded: Arc<AtomicBool>) -> std::io::Result<Vec<u8>> {
    let mut captured = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = pipe.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        captured.extend_from_slice(&buffer[..count.min(remaining)]);
        if count > remaining {
            exceeded.store(true, Ordering::Relaxed);
        }
    }
    Ok(captured)
}
pub fn execute(
    executable: &str, args: &[String], timeout_ms: u64, max_buffer: usize,
) -> Result<ProcessOutput, ProcessError> {
    let mut command = Command::new(executable);
    command.args(args);
    execute_command(command, timeout_ms, max_buffer)
}
pub fn execute_command(
    mut command: Command, timeout_ms: u64, max_buffer: usize,
) -> Result<ProcessOutput, ProcessError> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let exceeded = Arc::new(AtomicBool::new(false));
    let out = child.stdout.take().expect("piped stdout");
    let err = child.stderr.take().expect("piped stderr");
    let out_flag = exceeded.clone();
    let err_flag = exceeded.clone();
    let stdout = std::thread::spawn(move || capture(out, max_buffer, out_flag));
    let stderr = std::thread::spawn(move || capture(err, max_buffer, err_flag));
    let start = Instant::now();
    let mut killed = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if exceeded.load(Ordering::Relaxed) || (timeout_ms > 0 && start.elapsed() >= Duration::from_millis(timeout_ms))
        {
            killed = true;
            let _ = child.kill();
            break child.wait()?;
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    let read = |thread: std::thread::JoinHandle<std::io::Result<Vec<u8>>>| -> Result<String, ProcessError> {
        let bytes = thread.join().map_err(|_| std::io::Error::other("Process output reader panicked"))??;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    };
    let stdout = read(stdout)?;
    let stderr = read(stderr)?;
    if !status.success() || killed || exceeded.load(Ordering::Relaxed) {
        return Err(ProcessError {
            message: if exceeded.load(Ordering::Relaxed) {
                "Process output exceeded maxBuffer".into()
            } else if killed {
                "Process timed out".into()
            } else {
                format!("Process exited with {status}")
            },
            code: Box::new(serde_json::json!(status.code())),
            stdout,
            stderr,
            killed,
            signal: if killed { Some("SIGKILL") } else { None },
        });
    }
    Ok(ProcessOutput { stdout, stderr })
}
