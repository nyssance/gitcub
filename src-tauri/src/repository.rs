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
    if let Some(git_dir) = plain_git_dir(path) {
        return Ok(RepositoryType::Regular { top_level_working_directory: resolve(path, "")?, git_dir });
    }
    repository_type_via_git(path)
}

fn repository_type_via_git(path: &Path) -> Result<RepositoryType, String> {
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

/// 最常见的形状不起 git 进程：`path` 正是工作区根目录，`.git` 是一个普通的仓库目录，两者都属于当前用户。
/// 这时 `rev-parse --is-bare-repository --show-cdup --git-dir` 必然输出 `false`、空行、`.git`，返回的就是那个 `.git`。
/// 其余形状（子目录、gitfile、链接工作区、裸仓库、`core.worktree`、扩展、所有权不符、环境变量指定目录）一律交给 git。
pub fn plain_git_dir(path: &Path) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // 最后一个是 git 自己的测试开关（setup.c ensure_valid_ownership），原版测试用它模拟所有权不符
        if [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_COMMON_DIR",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_COUNT",
            "GIT_TEST_ASSUME_DIFFERENT_OWNER",
        ]
            .iter()
            .any(|name| std::env::var_os(name).is_some())
        {
            return None;
        }
        let git_dir = path.join(".git");
        let meta = std::fs::symlink_metadata(&git_dir).ok()?;
        // setup.c ensure_valid_ownership：工作区与 git 目录都属于当前用户才不看 safe.directory
        let uid = unsafe { libc::geteuid() };
        if !meta.is_dir() || meta.uid() != uid || std::fs::metadata(path).ok()?.uid() != uid {
            return None;
        }
        // setup.c is_git_directory：HEAD 合法，objects 与 refs 是目录；commondir 说明是链接工作区
        let plain_dir = |name: &str| std::fs::symlink_metadata(git_dir.join(name)).is_ok_and(|meta| meta.is_dir());
        if !plain_dir("objects") || !plain_dir("refs") || git_dir.join("commondir").exists() {
            return None;
        }
        let head = git_dir.join("HEAD");
        if !std::fs::symlink_metadata(&head).ok()?.is_file() {
            return None;
        }
        let head = std::fs::read_to_string(head).ok()?;
        let head = head.strip_suffix('\n')?;
        let detached = matches!(head.len(), 40 | 64) && head.bytes().all(|b| b.is_ascii_hexdigit());
        if !detached && !head.strip_prefix("ref: refs/").is_some_and(|name| !name.is_empty() && !name.contains(' ')) {
            return None;
        }
        // setup.c check_repository_format：只看仓库自己的 config
        let config =
            gix::config::File::from_path_no_includes(git_dir.join("config"), gix::config::Source::Local).ok()?;
        if config.sections().any(|section| {
            let name = section.header().name();
            [&b"include"[..], b"includeIf", b"extensions"].iter().any(|other| name.eq_ignore_ascii_case(other))
        }) || config.string("core.worktree").is_some()
            || !matches!(config.boolean("core.worktree"), Ok(None))
            || !matches!(config.boolean("core.bare"), Ok(None | Some(false)))
            || config.string("core.repositoryformatversion").is_some_and(|version| version != "0")
        {
            return None;
        }
        resolve(path, ".git").ok()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
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
    /// 进程内判断出的普通仓库必须和 git 的答案逐字段相同；其余形状一律让位
    #[cfg(unix)]
    #[test]
    fn 普通仓库不起进程_结果与_git_相同_其余形状让位() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        let git = |dir: &Path, args: &[&str]| Git::new(Some(dir)).args(args.iter().copied()).run().unwrap();
        let init = |name: &str| {
            let path = root.join(name);
            std::fs::create_dir_all(&path).unwrap();
            git(&path, &["init", "-q", "-b", "main"]);
            git(&path, &["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "base"]);
            path
        };
        let describe = |kind: RepositoryType| match kind {
            RepositoryType::Regular { top_level_working_directory, git_dir } => {
                format!("regular {} {}", top_level_working_directory.display(), git_dir.display())
            }
            RepositoryType::Bare => "bare".into(),
            RepositoryType::Missing => "missing".into(),
            RepositoryType::Unsafe { path } => format!("unsafe {path}"),
        };
        let check = |path: &Path, answered: bool| {
            let fast = plain_git_dir(path);
            assert_eq!(fast.is_some(), answered, "{}", path.display());
            if fast.is_some() {
                assert_eq!(
                    describe(repository_type(path).unwrap()),
                    describe(repository_type_via_git(path).unwrap()),
                    "{}",
                    path.display()
                );
            }
        };

        let plain = init("plain");
        check(&plain, true);
        // 路径带多余的 `.` 与结尾斜杠：结果仍按 Node path.resolve 折叠
        check(&plain.join("."), true);
        std::fs::create_dir(plain.join("sub")).unwrap();
        check(&plain.join("sub"), false);

        let detached = init("detached");
        git(&detached, &["checkout", "-q", "--detach"]);
        check(&detached, true);

        let unborn = root.join("unborn");
        std::fs::create_dir(&unborn).unwrap();
        git(&unborn, &["init", "-q", "-b", "main"]);
        check(&unborn, true);

        let linked = root.join("linked");
        git(&plain, &["worktree", "add", "-q", "-b", "linked", linked.to_str().unwrap()]);
        check(&linked, false);

        let bare = root.join("bare.git");
        std::fs::create_dir(&bare).unwrap();
        git(&bare, &["init", "-q", "--bare"]);
        check(&bare, false);

        let marked_bare = init("marked-bare");
        git(&marked_bare, &["config", "core.bare", "true"]);
        check(&marked_bare, false);

        let elsewhere = init("worktree-elsewhere");
        git(&elsewhere, &["config", "core.worktree", root.join("plain").to_str().unwrap()]);
        check(&elsewhere, false);

        let separate = root.join("separate");
        std::fs::create_dir(&separate).unwrap();
        git(&separate, &["init", "-q", "--separate-git-dir", root.join("separate.git").to_str().unwrap()]);
        check(&separate, false);

        let extension = init("extension");
        git(&extension, &["config", "extensions.worktreeConfig", "true"]);
        check(&extension, false);

        let broken = init("broken-head");
        std::fs::write(broken.join(".git/HEAD"), "garbage\n").unwrap();
        check(&broken, false);

        let none = root.join("none");
        std::fs::create_dir(&none).unwrap();
        check(&none, false);
    }

    #[test]
    fn windows真实路径保留盘符与网络共享() {
        assert_eq!(windows_git_path(r"\\?\C:\Users\repo"), "C:/Users/repo");
        assert_eq!(windows_git_path(r"\\?\UNC\server\share\repo"), "//server/share/repo");
        assert_eq!(windows_git_path(r"\\server\share\repo"), "//server/share/repo");
    }
}
