//! 对齐 Desktop lib/git/config.ts，保留空白和空值，并按 Git 自身规则解析布尔值。
use crate::git::{Git, stderr_of};
use std::path::{Path, PathBuf};

pub fn get(repo: Option<&Path>, key: &str, only_local: bool, boolean: bool) -> Result<Option<String>, String> {
    if !boolean {
        let value = match repo {
            Some(repo) if only_local => local_in_process(repo, key),
            None => global_in_process(key),
            Some(repo) => effective_in_process(repo, key),
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

/// `git config -z <key>` in process: every scope git reads for a repository (the bundled git's system config, global,
/// local, worktree; includes followed), the last value. Left to git (`None`): configuration injected through the
/// environment, a path that is not the top of a work tree, `includeIf` conditions other than `gitdir` and `onbranch`,
/// unusual keys, and empty or implicit values.
#[cfg(unix)]
pub fn effective_in_process(repo: &Path, key: &str) -> Option<Option<String>> {
    use crate::raw_diff::in_process;
    if ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL"]
        .iter()
        .any(|name| std::env::var_os(name).is_some())
    {
        return None;
    }
    // config.c git_config_system：GIT_CONFIG_NOSYSTEM 按布尔值读，为真就不读系统配置；写法不认识时让位
    let no_system = match std::env::var("GIT_CONFIG_NOSYSTEM").as_deref().map(str::to_ascii_lowercase).as_deref() {
        Err(std::env::VarError::NotPresent) | Ok("" | "0" | "false" | "no" | "off") => false,
        Ok("1" | "true" | "yes" | "on") => true,
        _ => return None,
    };
    // 用 PATH 上的 git 时，它读哪份安装级配置由那个 git 的编译参数决定（Apple 的 git 另读 Xcode 里的一份），
    // gix 看到的未必相同；只有打包的 git 的系统配置是确定的那一个文件。
    crate::git::bundled_system_config()?;
    let repo = in_process::open(repo).ok()?;
    let config = in_process::config(&repo).ok()?;
    effective_from(&if no_system { config.without_system() } else { config }, key)
}

/// The in-process repository reader is Unix-only; elsewhere every lookup goes to git.
#[cfg(not(unix))]
pub fn effective_in_process(_repo: &Path, _key: &str) -> Option<Option<String>> {
    None
}

#[cfg(unix)]
fn effective_from(config: &crate::raw_diff::in_process::Config<'_>, key: &str) -> Option<Option<String>> {
    if !simple_key(key) || !config.only_supported_conditions() {
        return None;
    }
    match config.file_string(key) {
        Some(value) if !value.is_empty() => Some(Some(String::from_utf8_lossy(value.as_ref()).into_owned())),
        Some(_) => None,
        None if config.file_present(key) => None,
        None => Some(None),
    }
}

/// `section.name` or `section.subsection.name` in the plain form git accepts without quoting rules to consider.
fn simple_key(key: &str) -> bool {
    let Some((section, rest)) = key.split_once('.') else { return false };
    let name = rest.rsplit_once('.').map_or(rest, |(_, name)| name);
    let valid = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    valid(section) && valid(name) && name.as_bytes()[0].is_ascii_alphabetic()
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
                found = Some(String::from_utf8_lossy(value.as_ref()).into_owned());
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

    /// `git config -z <key>` in process across every scope must print what git prints.
    #[cfg(unix)]
    #[test]
    fn 进程内有效配置与_git_一致_其余形状让位() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().canonicalize().unwrap();
        let r = r.as_path();
        Git::new(Some(r)).args(["init", "-q", "-b", "main"]).run().unwrap();
        std::fs::write(r.join(".git/extra"), "[included]\n\tname = From Include\n").unwrap();
        std::fs::write(r.join(".git/conditional"), "[conditional]\n\tname = From Condition\n").unwrap();
        let base = std::fs::read_to_string(r.join(".git/config")).unwrap();
        let with = |extra: &str| std::fs::write(r.join(".git/config"), format!("{base}{extra}")).unwrap();
        with(&format!(
            concat!(
                "[user]\n\tname = First\n\tname = \"  Quoted \\\"Name\\\"  \" ; comment\n",
                "\temail = a@example.invalid # trailing\n",
                "[include]\n\tpath = extra\n",
                "[includeIf \"gitdir:{}/\"]\n\tpath = conditional\n",
                "[core]\n\tflag\n\tempty =\n",
            ),
            r.display()
        ));
        let keys = [
            ("user.name", true),
            ("user.email", true),
            ("USER.Email", true),
            // 有效配置展开 include 与满足条件的 includeIf
            ("included.name", true),
            ("conditional.name", true),
            ("gitcubtest.missing", true),
            ("core.flag", false),
            ("core.empty", false),
            ("nodot", false),
        ];
        // 测试进程用 PATH 上的 git，对外的入口按设计让位；这里直接验解析这一层，键都由仓库自己的配置决定。
        assert_eq!(effective_in_process(r, "user.name"), None);
        let open = || crate::raw_diff::in_process::open(r).unwrap();
        for (key, answered) in keys {
            let repo = open();
            let fast = effective_from(&crate::raw_diff::in_process::config(&repo).unwrap(), key);
            assert_eq!(fast.is_some(), answered, "{key}: {fast:?}");
            if let Some(fast) = fast {
                assert_eq!(Ok(fast), get_via_git(Some(r), key, false, false), "{key}");
            }
        }
        // 子目录让位：git -C <子目录> 的语义留给 git
        std::fs::create_dir(r.join("sub")).unwrap();
        assert!(crate::raw_diff::in_process::open(&r.join("sub")).is_err());
        // 不认识的条件让位
        with("[user]\n\tname = Kept\n[includeIf \"hasconfig:remote.*.url:https://example.invalid/**\"]\n\tpath = conditional\n");
        let repo = open();
        assert_eq!(effective_from(&crate::raw_diff::in_process::config(&repo).unwrap(), "user.name"), None);
    }

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
