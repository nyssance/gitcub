//! Desktop console and daily file transport semantics, backed by native I/O.
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub fn is_broken_pipe(kind: io::ErrorKind) -> bool {
    kind == io::ErrorKind::BrokenPipe
}
pub fn console(message: &str) -> io::Result<()> {
    match writeln!(io::stderr().lock(), "{message}") {
        Err(error) if is_broken_pipe(error.kind()) => Ok(()),
        result => result,
    }
}

/// Opens lazily, rotates by UTC day, and only prunes this channel's log files.
pub struct DesktopFileTransport {
    directory: PathBuf,
    channel: String,
    stream: Option<(PathBuf, std::fs::File)>,
}
impl DesktopFileTransport {
    pub fn new(directory: PathBuf, channel: &str) -> Self {
        Self { directory, channel: channel.to_owned(), stream: None }
    }
    pub fn write(&mut self, millis: i64, message: &str) -> io::Result<()> {
        let date = chrono::DateTime::from_timestamp_millis(millis)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid log timestamp"))?;
        let suffix = format!(".desktop.{}.log", self.channel);
        let path = self.directory.join(format!("{}{suffix}", date.format("%Y-%m-%d")));
        if self.stream.as_ref().is_none_or(|(previous, _)| previous != &path) {
            self.close()?;
            let file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
            self.stream = Some((path, file));
            prune(&self.directory, &suffix)?;
        }
        let (_, file) = self.stream.as_mut().expect("Opened log file");
        file.write_all(message.as_bytes())?;
        file.write_all(if cfg!(windows) { b"\r\n" } else { b"\n" })?;
        file.flush()
    }
    pub fn close(&mut self) -> io::Result<()> {
        if let Some((_, mut file)) = self.stream.take() {
            file.flush()?;
        }
        Ok(())
    }
}
fn prune(directory: &Path, suffix: &str) -> io::Result<()> {
    let pattern =
        regex::Regex::new(&format!(r"\d{{4}}-\d{{2}}-\d{{2}}{}$", regex::escape(suffix))).map_err(io::Error::other)?;
    let mut entries = std::fs::read_dir(directory)?.collect::<io::Result<Vec<_>>>()?;
    entries.retain(|entry| {
        entry.file_type().is_ok_and(|kind| kind.is_file()) && pattern.is_match(&entry.file_name().to_string_lossy())
    });
    if entries.len() > 14 {
        entries.sort_by_key(|entry| entry.file_name());
        let count = entries.len() - 14 + 1;
        for entry in entries.into_iter().take(count) {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// Install as the application's actual Tauri log destination.
pub fn dispatch(directory: PathBuf) -> io::Result<tauri_plugin_log::fern::Dispatch> {
    std::fs::create_dir_all(&directory)?;
    let channel = if cfg!(debug_assertions) { "development" } else { "production" };
    let transport = Mutex::new(DesktopFileTransport::new(directory, channel));
    Ok(tauri_plugin_log::fern::Dispatch::new().chain(tauri_plugin_log::fern::Output::call(move |record| {
        let message = format!("{} {}", record.level(), record.args());
        let _ = console(&message);
        if let Err(error) = transport
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .write(chrono::Utc::now().timestamp_millis(), &message)
        {
            let _ = console(&format!("DesktopFileTransport: {error}"));
        }
    })))
}
