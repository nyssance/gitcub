//! 对齐 Desktop lib/git/config.ts，保留空白和空值，并按 Git 自身规则解析布尔值。
use crate::git::{Git, stderr_of};
use std::path::{Path, PathBuf};

pub fn get(repo: Option<&Path>, key: &str, only_local: bool, boolean: bool) -> Result<Option<String>, String> {
    if !boolean {
        let value = match repo {
            Some(repo) if only_local => local_in_process(repo, key),
            None => global_in_process(key),
            Some(_) => None,
        };
        if let Some(value) = value {
            return Ok(value);
        }
    }
    get_via_git(repo, key, only_local, boolean)
}

/// `git config -z --local <key>` in process: the repository's own `config` in the common directory,
/// includes not followed (a specific file), the last value normalized as git prints it. Empty or
/// implicit values, unusual keys and an unreadable file are left to git (`None`).
pub fn local_in_process(repo: &Path, key: &str) -> Option<Option<String>> {
    let repo = gix::open(repo).ok()?;
    in_files(&[repo.common_dir().join("config")], key)
}

/// `git config -z --global <key>` in process (builtin/config.c reads one file, `git_global_config`): `GIT_CONFIG_GLOBAL`
/// when set, otherwise `~/.gitconfig`, or `$XDG_CONFIG_HOME/git/config` (`~/.config/git/config`) only when
/// `~/.gitconfig` is missing and that one exists; without includes (a scoped read). No HOME goes to git.
pub fn global_in_process(key: &str) -> Option<Option<String>> {
    in_files(&global_files(|name| std::env::var_os(name))?, key)
}

fn global_files(env: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<Vec<PathBuf>> {
    let set = |name: &str| env(name).filter(|value| !value.is_empty()).map(PathBuf::from);
    Some(match env("GIT_CONFIG_GLOBAL") {
        Some(path) if path.is_empty() => return None,
        Some(path) => vec![PathBuf::from(path)],
        None => {
            let home = set("HOME")?;
            let xdg = set("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
            let (user, xdg) = (home.join(".gitconfig"), xdg.join("git").join("config"));
            vec![if user.exists() || !xdg.exists() { user } else { xdg }]
        }
    })
}

/// The last value of `key` across `files` (missing ones skipped), normalized as git prints it.
fn in_files(files: &[PathBuf], key: &str) -> Option<Option<String>> {
    let (section, rest) = key.split_once('.')?;
    let (subsection, name) = match rest.rsplit_once('.') {
        Some((subsection, name)) => (Some(subsection), name),
        None => (None, rest),
    };
    let valid = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !valid(section) || !valid(name) || !name.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    let mut found = None;
    for path in files {
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
            Ok(_) => {}
        }
        let file = gix::config::File::from_path_no_includes(path.clone(), gix::config::Source::Local).ok()?;
        // `Some(None)` is an implicit `key` (no `=`): present to git, not a string.
        match file.string_implicit_by(section, subsection.map(Into::into), name) {
            Some(Some(value)) if !value.is_empty() => {
                found = Some(String::from_utf8_lossy(value.as_ref()).into_owned())
            }
            Some(_) => return None,
            None => {}
        }
    }
    Some(found)
}

pub fn get_via_git(repo: Option<&Path>, key: &str, only_local: bool, boolean: bool) -> Result<Option<String>, String> {
    let mut git = Git::new(repo).args(["config", "-z"]);
    if repo.is_none() {
        git = git.arg("--global");
    } else if only_local {
        git = git.arg("--local");
    }
    if boolean {
        git = git.args(["--type", "bool"]);
    }
    let out = git.arg(key).output()?;
    match out.status.code() {
        Some(0) => Ok(Some(String::from_utf8_lossy(&out.stdout).split('\0').next().unwrap_or("").into())),
        Some(1) => Ok(None),
        _ => Err(stderr_of(&out)),
    }
}

pub fn set(repo: Option<&Path>, key: &str, value: &str) -> Result<(), String> {
    let mut git = Git::new(repo).arg("config");
    if repo.is_none() {
        git = git.arg("--global");
    }
    git.args(["--replace-all", key, value]).run()
}

pub fn global_path() -> Result<PathBuf, String> {
    let value = Git::new(None).args(["config", "--edit", "--global"]).env("GIT_EDITOR", "printf %s").stdout()?;
    Ok(PathBuf::from(value))
}

pub fn add_safe_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("目录信任例外必须使用绝对路径".into());
    }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err("信任例外必须是一个目录".into());
    }
    let mut path = crate::repository::git_path(&canonical);
    if path.ends_with("/*") {
        return Err("信任例外只能指定一个确切目录".into());
    }
    if cfg!(windows) && path.starts_with('/') {
        path = format!("%(prefix)/{path}");
    }
    let out = Git::new(None)
        .args(["config", "--global", "-z", "--fixed-value", "--get-all", "safe.directory", &path])
        .output()?;
    match out.status.code() {
        Some(0) if String::from_utf8_lossy(&out.stdout).split('\0').any(|v| v == path) => Ok(()),
        Some(0 | 1) => Git::new(None).args(["config", "--global", "--add", "safe.directory", &path]).run(),
        _ => Err(stderr_of(&out)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `git config -z --local` in process must print what git prints, byte for byte.
    #[test]
    fn 进程内本地配置与_git_逐字节一致() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        Git::new(Some(r)).args(["init", "-q", "-b", "main"]).run().unwrap();
        std::fs::write(r.join(".git/extra"), "[user]\n\tname = Included\n").unwrap();
        let mut config = std::fs::read_to_string(r.join(".git/config")).unwrap();
        config.push_str(concat!(
            "[user]\n\tname = First\n\tNAME = \"  Quoted \\\"Name\\\"  \" ; comment\n",
            "\temail = a@example.invalid # trailing\n",
            "[include]\n\tpath = extra\n",
            "[branch \"Feature/X\"]\n\tremote = origin\n",
            "[core]\n\tflag\n\tempty =\n",
            "[Multi]\n\tline = one \\\n two\n",
        ));
        std::fs::write(r.join(".git/config"), config).unwrap();
        let keys = [
            ("user.name", true),
            ("user.email", true),
            ("USER.Email", true),
            ("branch.Feature/X.remote", true),
            ("branch.feature/x.remote", true),
            ("multi.line", true),
            ("user.missing", true),
            ("core.flag", false),
            ("core.empty", false),
            ("nodot", false),
        ];
        for (key, answered) in keys {
            let fast = local_in_process(r, key);
            assert_eq!(fast.is_some(), answered, "{key}: {fast:?}");
            let git = get_via_git(Some(r), key, true, false);
            if let Some(fast) = fast {
                assert_eq!(Ok(fast), git, "{key}");
            }
        }

        // A linked worktree reads the common directory's config, not its own git dir.
        Git::new(Some(r))
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@example.invalid",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "base",
            ])
            .run()
            .unwrap();
        let linked = d.path().join("linked");
        Git::new(Some(r)).args(["worktree", "add", "-q", "-b", "linked"]).arg(&linked).run().unwrap();
        let fast = local_in_process(&linked, "user.email");
        assert_eq!(fast.clone().unwrap(), get_via_git(Some(&linked), "user.email", true, false).unwrap());
        assert_eq!(fast, Some(Some("a@example.invalid".into())));
    }

    /// `git config -z --global` in process against git run with the same HOME / XDG_CONFIG_HOME / GIT_CONFIG_GLOBAL:
    /// both files (only ~/.gitconfig counts), only one, the XDG default under HOME, the override file, includes not followed
    #[test]
    fn 进程内全局配置与_git_一致() {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().join("home");
        let xdg = d.path().join("xdg");
        std::fs::create_dir_all(home.join(".config/git")).unwrap();
        std::fs::create_dir_all(xdg.join("git")).unwrap();
        let included = d.path().join("included");
        std::fs::write(&included, "[user]\n\temail = included@example.invalid\n").unwrap();
        let write = |path: &Path, text: &str| std::fs::write(path, text).unwrap();
        let shapes: [(&str, Vec<(&str, &Path)>); 4] = [
            ("HOME only", vec![("HOME", &home)]),
            ("HOME and XDG_CONFIG_HOME", vec![("HOME", &home), ("XDG_CONFIG_HOME", &xdg)]),
            ("GIT_CONFIG_GLOBAL", vec![("HOME", &home), ("GIT_CONFIG_GLOBAL", &included)]),
            ("XDG_CONFIG_HOME without its file", vec![("HOME", &home), ("XDG_CONFIG_HOME", d.path())]),
        ];
        let layouts = [
            (
                Some("[user]\n\tname = Home\n[include]\n\tpath = ../included\n"),
                Some("[user]\n\tname = Xdg\n\temail = xdg@example.invalid\n"),
            ),
            (None, Some("[user]\n\tname = Xdg\n")),
            (Some("[user]\n\tname = Home\n"), None),
        ];
        for (gitconfig, xdg_config) in layouts {
            for (path, text) in [
                (home.join(".gitconfig"), gitconfig),
                (xdg.join("git/config"), xdg_config),
                (home.join(".config/git/config"), xdg_config),
            ] {
                match text {
                    Some(text) => write(&path, text),
                    None => _ = std::fs::remove_file(&path),
                }
            }
            for (shape, env) in &shapes {
                let lookup = |name: &str| {
                    env.iter().find(|(key, _)| *key == name).map(|(_, value)| value.as_os_str().to_owned())
                };
                let files = global_files(lookup).unwrap();
                for key in ["user.name", "user.email", "user.missing"] {
                    let mut git = std::process::Command::new("git");
                    git.args(["config", "-z", "--global", key])
                        .env_remove("GIT_CONFIG_GLOBAL")
                        .env_remove("XDG_CONFIG_HOME");
                    for (name, value) in env {
                        git.env(name, value);
                    }
                    let out = git.output().unwrap();
                    let expected = (out.status.code() == Some(0))
                        .then(|| String::from_utf8_lossy(&out.stdout).split('\0').next().unwrap_or("").to_owned());
                    assert_eq!(in_files(&files, key), Some(expected), "{shape} {gitconfig:?} {xdg_config:?}: {key}");
                }
            }
        }
        assert_eq!(
            global_files(|name| (name == "GIT_CONFIG_GLOBAL").then(Default::default)),
            None,
            "empty override goes to git"
        );
        assert_eq!(global_files(|_| None), None, "no HOME goes to git");
    }
}
