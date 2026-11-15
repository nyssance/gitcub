//! Desktop app/src/lib/git/gitignore.ts：拒绝符号链接、保持 Git 换行配置、追加与转义。
use crate::git::Git;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
const SYMLINK: &str = "Cannot use a symbolic link as the root .gitignore file";

fn ensure_regular(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(SYMLINK.into()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn options(write: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(!write).write(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT：打开链接本身，后续 metadata 拒绝它。
        options.custom_flags(0x00200000);
    }
    options
}

fn open_existing(path: &Path, write: bool) -> Result<Option<File>, String> {
    let file = match options(write).open(path) {
        Ok(file) => file,
        Err(error) => {
            ensure_regular(path)?;
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(error.to_string());
        }
    };
    let meta = file.metadata().map_err(|error| error.to_string())?;
    let path_meta = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if meta.file_type().is_symlink() || path_meta.file_type().is_symlink() {
        return Err(SYMLINK.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.dev() != path_meta.dev() || meta.ino() != path_meta.ino() {
            return Err(SYMLINK.into());
        }
    }
    Ok(Some(file))
}

pub fn read(repo: &Path) -> Result<Option<String>, String> {
    let Some(mut file) = open_existing(&repo.join(".gitignore"), false)? else {
        return Ok(None);
    };
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(|error| error.to_string())?;
    Ok(Some(text))
}

fn config(repo: &Path, key: &str) -> Result<Option<String>, String> {
    let out = Git::new(Some(repo)).args(["config", "--get", key]).output()?;
    match out.status.code() {
        Some(0) => Ok(Some(String::from_utf8_lossy(&out.stdout).trim().into())),
        Some(1) => Ok(None),
        _ => Err(crate::git::stderr_of(&out)),
    }
}

fn format(repo: &Path, text: &str) -> Result<String, String> {
    let autocrlf = config(repo, "core.autocrlf")?;
    let safecrlf = config(repo, "core.safecrlf")?;
    if autocrlf.as_deref() == Some("true") && safecrlf.as_deref() == Some("true") {
        // 等价于上游 /\r\n|\n\r|\n|\r/g；连续 replace 会错误合并重叠的换行。
        let mut normalized = String::new();
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\r' || ch == '\n' {
                if chars.peek().is_some_and(|next| *next != ch && (*next == '\r' || *next == '\n')) {
                    chars.next();
                }
                normalized.push_str("\r\n");
            } else {
                normalized.push(ch);
            }
        }
        return Ok(format!("{normalized}\r\n"));
    }
    if text.is_empty() || text.ends_with('\n') {
        return Ok(text.into());
    }
    Ok(format!("{text}{}", if autocrlf.is_none() || autocrlf.as_deref() == Some("true") { "\n" } else { "\r\n" }))
}

pub fn save(repo: &Path, text: &str) -> Result<(), String> {
    let path = repo.join(".gitignore");
    if text.is_empty() {
        ensure_regular(&path)?;
        return fs::remove_file(path).map_err(|error| error.to_string());
    }
    let text = format(repo, text)?;
    let mut file = match open_existing(&path, true)? {
        Some(file) => file,
        None => options(true).create_new(true).open(&path).map_err(|error| error.to_string())?,
    };
    file.set_len(0).map_err(|error| error.to_string())?;
    file.write_all(text.as_bytes()).map_err(|error| error.to_string())
}

pub fn escape(pattern: &str) -> String {
    let mut result = String::new();
    for ch in pattern.chars() {
        if matches!(ch, '[' | ']' | '!' | '*' | '#' | '?') {
            result.push('\\');
        }
        result.push(ch);
    }
    result
}

pub fn append_rules(repo: &Path, patterns: &[String]) -> Result<(), String> {
    let current = format(repo, &read(repo)?.unwrap_or_default())?;
    let text = format(repo, &format!("{current}{}", patterns.join("\n")))?;
    save(repo, &text)
}

pub fn append_files(repo: &Path, paths: &[String]) -> Result<(), String> {
    append_rules(repo, &paths.iter().map(|path| escape(path)).collect::<Vec<_>>())
}
