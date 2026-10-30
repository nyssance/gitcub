//! Native file utilities used by Desktop compatibility commands.
use serde::Serialize;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct FileError {
    pub code: &'static str,
    pub message: String,
}
impl From<std::io::Error> for FileError {
    fn from(error: std::io::Error) -> Self {
        Self {
            code: match error.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                std::io::ErrorKind::NotADirectory => "ENOTDIR",
                _ => "EIO",
            },
            message: error.to_string(),
        }
    }
}
pub fn file_hash(path: &Path, algorithm: &str) -> Result<String, FileError> {
    let kind = match algorithm {
        "sha1" => gix::hash::Kind::Sha1,
        "sha256" => gix::hash::Kind::Sha256,
        _ => return Err(FileError { code: "EINVAL", message: format!("Unsupported hash algorithm: {algorithm}") }),
    };
    let mut file = std::fs::File::open(path)?;
    let mut hasher = gix::hash::hasher(kind);
    let mut bytes = [0; 65536];
    loop {
        let size = file.read(&mut bytes)?;
        if size == 0 {
            break;
        }
        hasher.update(&bytes[..size]);
    }
    hasher
        .try_finalize()
        .map(|hash| hash.to_string())
        .map_err(|error| FileError { code: "EIO", message: error.to_string() })
}
pub fn normalized(path: &Path) -> Result<PathBuf, String> {
    let mut result = PathBuf::new();
    for part in std::path::absolute(path).map_err(|e| e.to_string())?.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(part.as_os_str()),
        }
    }
    Ok(result)
}
pub fn resolve_within(root: &Path, segments: &[String]) -> Result<Option<PathBuf>, String> {
    if root.as_os_str().is_empty()
        || root.to_string_lossy().contains('\0')
        || segments.iter().any(|part| part.contains('\0'))
    {
        return Ok(None);
    }
    let mut target = root.to_path_buf();
    for segment in segments {
        target.push(segment);
    }
    let resolved = normalized(&target)?;
    let real_root = root.canonicalize().map_err(|e| e.to_string())?;
    let real_target = resolved.canonicalize().map_err(|e| e.to_string())?;
    // Match whole path components, including for similarly prefixed sibling directories.
    Ok(real_target.starts_with(real_root).then_some(resolved))
}
pub fn encode_path_url(segments: &[String]) -> Result<String, String> {
    let mut target = PathBuf::new();
    for segment in segments {
        target.push(segment);
    }
    reqwest::Url::from_file_path(normalized(&target)?).map(|url| url.to_string()).map_err(|_| "Invalid file URL".into())
}
pub fn is_application_bundle_metadata(metadata: &str) -> Result<bool, String> {
    if ["com.apple.application-bundle", "com.apple.application", "public.executable"]
        .iter()
        .any(|id| metadata.contains(&format!("\"{id}\"")))
    {
        return Ok(true);
    }
    let primary = metadata.lines().find_map(|line| {
        let (key, value) = line.trim().split_once('=')?;
        (key.trim() == "kMDItemContentType").then_some(value.trim())
    });
    if primary == Some("\"public.folder\"") {
        return Ok(false);
    }
    Err("Metadata did not conclusively identify a directory".into())
}

/// Return a random path without creating the file (Desktop getTempFilePath).
pub fn temporary_file_path(name: &str) -> Result<PathBuf, String> {
    let mut random = [0; 8];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(std::env::temp_dir().join(format!("{name}-{suffix}")))
}
/// Read an inclusive byte range, bounded by EOF without loading the whole file.
pub fn read_partial_file(path: &Path, start: u64, end: u64) -> Result<Vec<u8>, String> {
    use std::io::{Seek, SeekFrom};
    let count = end.checked_sub(start).and_then(|n| n.checked_add(1)).ok_or("Invalid byte range")?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(count).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

pub fn file_size(path: &Path) -> Result<u64, String> {
    std::fs::metadata(path).map(|metadata| metadata.len()).map_err(|e| e.to_string())
}
/// Enforce the conflict-context memory bound during the read, even if the file
/// grows after stat. UTF-8 replacement matches Node's readFile(..., 'utf8').
pub fn read_conflict_text(path: &Path) -> Result<String, String> {
    const MAX_SIZE: usize = 10 * 1024 * 1024;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take((MAX_SIZE + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SIZE {
        return Err("File too large to resolve automatically".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub size: u64,
    pub is_directory: bool,
    pub modified_millis: u64,
}
pub fn metadata(path: &Path) -> Result<FileMetadata, String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(FileMetadata {
        size: metadata.len(),
        is_directory: metadata.is_dir(),
        modified_millis: u64::try_from(modified.as_millis()).map_err(|e| e.to_string())?,
    })
}
pub fn unlink_file(path: &Path) -> Result<(), FileError> {
    std::fs::remove_file(path).map_err(Into::into)
}
pub fn remove_file(path: &Path) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
pub fn path_exists(path: &Path) -> Result<bool, String> {
    path.try_exists().map_err(|e| e.to_string())
}
pub fn trash_path(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

/// Classify macOS bundles using Spotlight without executing the target path.
pub fn is_application_bundle(path: &Path) -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        return Ok(false);
    }
    let path = std::path::absolute(path).map_err(|e| e.to_string())?;
    let out = std::process::Command::new("/usr/bin/mdls")
        .args(["-name", "kMDItemContentType", "-name", "kMDItemContentTypeTree"])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    is_application_bundle_metadata(&String::from_utf8_lossy(&out.stdout))
}

pub fn read_directory(path: &Path) -> Result<Vec<String>, FileError> {
    std::fs::read_dir(path)
        .map_err(FileError::from)?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()).map_err(FileError::from))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conflict_reader_enforces_bound_and_replaces_invalid_utf8() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("conflict");
        std::fs::write(&path, [b'a', 0xff, b'b']).unwrap();
        assert_eq!(file_size(&path).unwrap(), 3);
        assert_eq!(read_conflict_text(&path).unwrap(), "a\u{fffd}b");
        std::fs::File::create(&path).unwrap().set_len(10 * 1024 * 1024 + 1).unwrap();
        assert!(read_conflict_text(&path).unwrap_err().contains("too large"));
    }
}
