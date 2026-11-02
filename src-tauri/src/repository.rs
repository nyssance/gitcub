//! Desktop lib/git/rev-parse.ts 的仓库发现与所有权诊断；不从诊断文本提取不可信路径。
use crate::git::{Git, stderr_of};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RepositoryType {
    Bare,
    Missing,
    Unsafe {
        path: String,
    },
    Regular {
        #[serde(rename = "topLevelWorkingDirectory")]
        top_level_working_directory: PathBuf,
        #[serde(rename = "gitDir")]
        git_dir: PathBuf,
    },
}

pub fn repository_type(path: &Path) -> Result<RepositoryType, String> {
    if !path.is_dir() {
        return Ok(RepositoryType::Missing);
    }
    let out = Git::new(Some(path))
        .args(["rev-parse", "--is-bare-repository", "--show-cdup", "--git-dir"])
        .env("LC_ALL", "C")
        .output()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if out.status.success() {
        if stdout.starts_with("true\n") {
            return Ok(RepositoryType::Bare);
        }
        if let Some(rest) = stdout.strip_prefix("false\n")
            && let Some((cdup, git_dir)) = rest.split_once('\n')
            && let Some(git_dir) = git_dir.strip_suffix('\n')
        {
            return Ok(RepositoryType::Regular {
                top_level_working_directory: resolve(path, cdup)?,
                git_dir: resolve(path, git_dir)?,
            });
        }
    }
    let diagnostic = "\nfatal: detected dubious ownership in repository at ";
    let stderr = format!("\n{}", String::from_utf8_lossy(&out.stderr));
    if stderr.contains(diagnostic) {
        let mut candidate = path.canonicalize().map_err(|e| e.to_string())?;
        loop {
            let git_path = git_path(&candidate);
            if stderr.contains(&format!("{diagnostic}'{git_path}'\n")) {
                return Ok(RepositoryType::Unsafe { path: git_path });
            }
            if !candidate.pop() {
                return Err("无法确认所有权异常对应的仓库目录".into());
            }
        }
    }
    if out.status.code() == Some(128) { Ok(RepositoryType::Missing) } else { Err(stderr_of(&out)) }
}

pub fn git_path(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    if cfg!(windows) { windows_git_path(&value) } else { value }
}

pub fn working_directory(path: &Path) -> Result<PathBuf, String> {
    match repository_type(path)? {
        RepositoryType::Regular { top_level_working_directory, .. } => Ok(top_level_working_directory),
        RepositoryType::Unsafe { path } => Err(format!("仓库所有权不受信任：{path}")),
        RepositoryType::Bare => Err("裸仓库没有可打开的工作区".into()),
        RepositoryType::Missing => Err("此目录不属于 Git 仓库".into()),
    }
}

// 对齐 Node path.resolve：折叠 . / ..，但不把用户路径中的符号链接改成 realpath。
fn resolve(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(base.join(relative)).map_err(|e| e.to_string())?;
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

fn windows_git_path(value: &str) -> String {
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(value).replace('\\', "/")
    }
}

/// Default description is a Git placeholder, not user-authored text.
pub fn description(repo: &Path) -> String {
    let contents = std::fs::read_to_string(repo.join(".git/description")).unwrap_or_default();
    if contents == "Unnamed repository; edit this file 'description' to name the repository.\n" {
        String::new()
    } else {
        contents
    }
}

/// Desktop new-repository defaults, shared by the creation command.
pub fn write_git_attributes(repo: &Path) -> Result<(), String> {
    use std::io::Write;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(repo.join(".gitattributes")) {
        Ok(mut file) => file
            .write_all(b"# Auto detect text files and perform LF normalization\n* text=auto\n")
            .map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn write_default_readme(path: &Path, name: &str, description: Option<&str>) -> Result<(), String> {
    let contents = match description {
        Some(description) => format!("# {name}\n{description}\n"),
        None => format!("# {name}\n"),
    };
    std::fs::write(path.join("README.md"), contents).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows真实路径保留盘符与网络共享() {
        assert_eq!(windows_git_path(r"\\?\C:\Users\repo"), "C:/Users/repo");
        assert_eq!(windows_git_path(r"\\?\UNC\server\share\repo"), "//server/share/repo");
        assert_eq!(windows_git_path(r"\\server\share\repo"), "//server/share/repo");
    }
}
