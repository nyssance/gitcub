//! File watching and bounded positional reads for Desktop's Tailer. One watch
//! owns one native watcher; dropping it cancels delivery.
use crate::file_system::FileError;
#[cfg(not(target_os = "macos"))]
use notify::{RecommendedWatcher as FileWatcher, RecursiveMode, Watcher};
#[cfg(target_os = "macos")]
type FileWatcher = Option<std::thread::JoinHandle<()>>;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
#[derive(Default)]
pub struct Watches {
    next: AtomicU64,
    handles: Mutex<HashMap<u64, ActiveWatch>>,
}
struct ActiveWatch {
    _watcher: FileWatcher,
    delivering: Arc<Mutex<bool>>,
}
impl Drop for ActiveWatch {
    fn drop(&mut self) {
        // Wait for any in-flight callback before unwatch returns. notify's
        // watcher drop alone can leave an already queued callback running.
        *self.delivering.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
        #[cfg(target_os = "macos")]
        if let Some(thread) = self._watcher.take() {
            let _ = thread.join();
        }
    }
}
impl Watches {
    pub fn watch(&self, path: &Path, send: impl Fn(serde_json::Value) + Send + 'static) -> Result<u64, String> {
        let delivering = Arc::new(Mutex::new(true));
        let active = delivering.clone();
        let watcher = watch_file(path, active, send)?;
        let handle = ActiveWatch { _watcher: watcher, delivering };
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.handles.lock().map_err(|_| "File watch lock poisoned")?.insert(id, handle);
        Ok(id)
    }
    pub fn unwatch(&self, id: u64) -> Result<(), String> {
        self.handles.lock().map_err(|_| "File watch lock poisoned")?.remove(&id);
        Ok(())
    }
}
#[cfg(not(target_os = "macos"))]
fn watch_file(
    path: &Path, active: Arc<Mutex<bool>>, send: impl Fn(serde_json::Value) + Send + 'static,
) -> Result<FileWatcher, String> {
    let mut watcher = FileWatcher::new(
        move |result: notify::Result<notify::Event>| {
            let guard = active.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if !*guard {
                return;
            }
            match result {
                Ok(event) => {
                    let kind = match event.kind {
                        notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                        | notify::EventKind::Remove(_)
                        | notify::EventKind::Create(_) => "rename",
                        notify::EventKind::Modify(_) => "change",
                        _ => return,
                    };
                    send(serde_json::json!({"event":kind}));
                }
                Err(error) => send(serde_json::json!({"error":error.to_string()})),
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher.watch(path, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    Ok(watcher)
}

// Per-file vnode events are needed for a log that remains open while appending.
// Keep this separate from notify's global backend feature: repository trees use FSEvents.
#[cfg(target_os = "macos")]
fn watch_file(
    path: &Path, active: Arc<Mutex<bool>>, send: impl Fn(serde_json::Value) + Send + 'static,
) -> Result<FileWatcher, String> {
    use kqueue::{EventData, EventFilter, FilterFlag, Vnode};
    let mut watcher = kqueue::Watcher::new().map_err(|e| e.to_string())?;
    watcher
        .add_filename(
            path,
            EventFilter::EVFILT_VNODE,
            FilterFlag::NOTE_WRITE
                | FilterFlag::NOTE_EXTEND
                | FilterFlag::NOTE_ATTRIB
                | FilterFlag::NOTE_RENAME
                | FilterFlag::NOTE_DELETE
                | FilterFlag::NOTE_REVOKE,
        )
        .map_err(|e| e.to_string())?;
    watcher.watch().map_err(|e| e.to_string())?;
    let thread = std::thread::Builder::new()
        .name("file-tail".into())
        .spawn(move || {
            loop {
                let event = watcher.poll(Some(std::time::Duration::from_millis(100)));
                let guard = active.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if !*guard {
                    break;
                }
                match event.map(|event| event.data) {
                    Some(EventData::Vnode(Vnode::Rename | Vnode::Delete | Vnode::Revoke)) => {
                        send(serde_json::json!({"event":"rename"}))
                    }
                    Some(EventData::Vnode(_)) => send(serde_json::json!({"event":"change"})),
                    Some(EventData::Error(error)) => send(serde_json::json!({"error":error.to_string()})),
                    _ => {}
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Some(thread))
}

pub fn read(path: &Path, position: u64, length: usize) -> Result<Vec<u8>, FileError> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(position))?;
    let mut bytes = Vec::new();
    file.take(length.min(65536) as u64).read_to_end(&mut bytes)?;
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, time::Duration};
    #[test]
    fn range_reads_obey_observed_end_and_eof() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"first\nsecond\n").unwrap();
        assert_eq!(read(file.path(), 0, 6).unwrap(), b"first\n");
        assert_eq!(read(file.path(), 6, 7).unwrap(), b"second\n");
        assert!(read(file.path(), 99, 7).unwrap().is_empty());
    }
    #[test]
    fn watching_reports_actual_appends_and_stops() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        let watches = Watches::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let id = watches
            .watch(file.path(), move |event| {
                let _ = tx.send(event);
            })
            .unwrap();
        file.write_all(b"first\n").unwrap();
        file.flush().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let event = rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())).unwrap();
            if event["event"] == "change" {
                break;
            }
        }
        watches.unwatch(id).unwrap();
        while rx.try_recv().is_ok() {}
        file.write_all(b"second\n").unwrap();
        file.flush().unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }
}
