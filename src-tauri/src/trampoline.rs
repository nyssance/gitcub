//! Loopback transport for Desktop's original credential trampoline. Protocol
//! parsing/account lookup live in the shared original TypeScript handlers.
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
#[derive(Default)]
pub struct Service(Mutex<Option<Server>>);
struct Server {
    port: u16,
    inner: Arc<Inner>,
    thread: Option<std::thread::JoinHandle<()>>,
}
struct Inner {
    stop: AtomicBool,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, TcpStream>>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.inner.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Ok(mut pending) = self.inner.pending.lock() {
            for (_, socket) in pending.drain() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }
}
impl Service {
    pub fn start(&self, send: impl Fn(serde_json::Value) + Send + Sync + 'static) -> Result<u16, String> {
        let mut server = self.0.lock().map_err(|_| "Trampoline lock poisoned")?;
        if let Some(server) = server.as_ref() {
            return Ok(server.port);
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let inner = Arc::new(Inner {
            stop: AtomicBool::new(false),
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        });
        let worker = inner.clone();
        let send = Arc::new(send);
        let thread = std::thread::spawn(move || {
            while !worker.stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        let id = worker.next.fetch_add(1, Ordering::Relaxed);
                        let Ok(copy) = socket.try_clone() else { continue };
                        {
                            let Ok(mut pending) = worker.pending.lock() else { break };
                            if pending.len() >= 32 {
                                continue;
                            }
                            pending.insert(id, copy);
                        }
                        let send = send.clone();
                        let active = worker.clone();
                        std::thread::spawn(move || {
                            let result = read_request(socket);
                            if let Ok(values) = result {
                                if !active.stop.load(Ordering::Relaxed) {
                                    send(serde_json::json!({"id":id,"values":values}));
                                }
                            } else if let Ok(mut pending) = active.pending.lock() {
                                pending.remove(&id);
                            }
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        *server = Some(Server { port, inner, thread: Some(thread) });
        Ok(port)
    }
    pub fn respond(&self, id: u64, result: &str) -> Result<(), String> {
        let guard = self.0.lock().map_err(|_| "Trampoline lock poisoned")?;
        let server = guard.as_ref().ok_or("Trampoline not running")?;
        let socket = server.inner.pending.lock().map_err(|_| "Trampoline pending lock poisoned")?.remove(&id);
        if let Some(mut socket) = socket {
            socket.set_write_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
            socket.write_all(result.as_bytes()).map_err(|e| e.to_string())?;
            let _ = socket.shutdown(Shutdown::Both);
        }
        Ok(())
    }
}
fn read_request(mut socket: TcpStream) -> std::io::Result<Vec<String>> {
    socket.set_read_timeout(Some(Duration::from_secs(30)))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut values = Vec::new();
    let mut value = Vec::new();
    let mut total = 0usize;
    let mut arguments = None;
    let mut expected = None;
    let mut bytes = [0u8; 4096];
    loop {
        if Instant::now() >= deadline {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Trampoline request deadline"));
        }
        let size = socket.read(&mut bytes)?;
        if size == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        for byte in &bytes[..size] {
            total += 1;
            if total > 1024 * 1024 {
                return Err(std::io::Error::other("Trampoline request too large"));
            }
            if *byte != 0 {
                value.push(*byte);
                continue;
            }
            let text = String::from_utf8(std::mem::take(&mut value))
                .map_err(|_| std::io::Error::other("Invalid trampoline UTF-8"))?;
            values.push(text);
            let count = |text: &str| {
                text.parse::<usize>()
                    .ok()
                    .filter(|n| *n <= 1024)
                    .ok_or_else(|| std::io::Error::other("Invalid trampoline count"))
            };
            if values.len() == 1 {
                arguments = Some(count(&values[0])?);
            }
            if let Some(args) = arguments
                && values.len() == args + 2
            {
                expected = Some(args + 3 + count(values.last().unwrap())?);
            }
            if expected == Some(values.len()) {
                return Ok(values);
            }
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Helpers {
    pub askpass: String,
    pub credential_helper: String,
    pub ssh_wrapper: String,
}
static DIRECTORY: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
static DIRECTORY_LOCK: Mutex<()> = Mutex::new(());
pub fn helpers() -> std::io::Result<Helpers> {
    let _lock = DIRECTORY_LOCK.lock().map_err(|_| std::io::Error::other("Helper lock poisoned"))?;
    let directory = if let Some(dir) = DIRECTORY.get() {
        dir
    } else {
        let dir = tempfile::Builder::new().prefix("gitcub-trampoline-").tempdir()?;
        for (name, bytes) in [
            ("askpass", include_bytes!(env!("GITCUB_ASKPASS_PATH")).as_slice()),
            ("git-credential-desktop", include_bytes!(env!("GITCUB_CREDENTIAL_HELPER_PATH")).as_slice()),
            ("ssh-wrapper", include_bytes!(env!("GITCUB_SSH_WRAPPER_PATH")).as_slice()),
        ] {
            let path = dir.path().join(format!("{name}{}", if cfg!(windows) { ".exe" } else { "" }));
            std::fs::write(&path, bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        let _ = DIRECTORY.set(dir);
        DIRECTORY.get().unwrap()
    };
    let path = |name: &str| {
        directory
            .path()
            .join(format!("{name}{}", if cfg!(windows) { ".exe" } else { "" }))
            .to_string_lossy()
            .into_owned()
    };
    Ok(Helpers {
        askpass: path("askpass"),
        credential_helper: path("git-credential-desktop"),
        ssh_wrapper: path("ssh-wrapper"),
    })
}

pub fn environment() -> serde_json::Value {
    serde_json::json!({"path":std::env::var("PATH").unwrap_or_default(),"configParameters":std::env::var("GIT_CONFIG_PARAMETERS").unwrap_or_default(),"platform":if cfg!(windows){"win32"}else if cfg!(target_os="macos"){"darwin"}else{"linux"},"arch":if cfg!(target_arch="aarch64"){"arm64"}else{"x64"}})
}
