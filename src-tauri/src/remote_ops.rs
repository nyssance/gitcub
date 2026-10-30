//! Desktop git/remote.ts：URL 按字面量读写，保留空白并让 Git 处理 insteadOf。
use crate::git::Git;
use std::collections::BTreeSet;
use std::path::Path;

pub fn get_url(repo: &Path, name: &str) -> Result<Option<String>, String> {
    if let Some(url) = fetch_url_in_process(repo, name) {
        return Ok(url);
    }
    get_url_via_git(repo, name)
}

/// Remote URLs as remote.c reads them (`handle_config`, `add_url`, `alias_url`). `None` when the
/// configuration holds something only git should interpret: an empty or implicit value, a name git
/// ignores, or a `transfer.credentialsInUrl` policy.
struct RemoteConfig {
    /// name → (URLs in config order, has a key in local or worktree config)
    remotes: std::collections::BTreeMap<String, (Vec<Vec<u8>>, bool)>,
    rewrites: Vec<(Vec<u8>, Vec<Vec<u8>>)>,
}

impl RemoteConfig {
    fn read(repo: &gix::Repository) -> Option<Self> {
        let config = repo.config_snapshot();
        let file = config.plumbing();
        if file.string("transfer.credentialsInUrl").is_some_and(|value| value.as_ref() as &[u8] != b"allow") {
            return None;
        }
        let mut remotes = std::collections::BTreeMap::<String, (Vec<Vec<u8>>, bool)>::new();
        let mut rewrites: Vec<(Vec<u8>, Vec<Vec<u8>>)> = Vec::new();
        for section in file.sections() {
            let header = section.header();
            let section_name = header.name();
            let Some(subsection) = header.subsection_name() else { continue };
            if section_name.eq_ignore_ascii_case(b"url") {
                let instead_of = section.values("insteadOf");
                if instead_of.is_empty() {
                    continue;
                }
                let base = subsection.to_vec();
                let index = match rewrites.iter().position(|(existing, _)| *existing == base) {
                    Some(index) => index,
                    None => {
                        rewrites.push((base, Vec::new()));
                        rewrites.len() - 1
                    }
                };
                for value in instead_of {
                    if value.is_empty() {
                        return None;
                    }
                    rewrites[index].1.push(value.to_vec());
                }
            } else if section_name.eq_ignore_ascii_case(b"remote") {
                if section.value_names().next().is_none() {
                    continue;
                }
                let name = std::str::from_utf8(subsection).ok()?;
                if name.is_empty() || name.starts_with('/') {
                    return None;
                }
                let entry = remotes.entry(name.to_string()).or_default();
                if matches!(section.meta().source, gix::config::Source::Local | gix::config::Source::Worktree) {
                    entry.1 = true;
                }
                for value in section.values("url") {
                    if value.is_empty() {
                        return None;
                    }
                    entry.0.push(value.to_vec());
                }
            }
        }
        Some(Self { remotes, rewrites })
    }

    /// The first fetch URL with the longest `insteadOf` applied; ties keep the earlier rewrite.
    fn first_url(&self, name: &str) -> Option<String> {
        let url = self.remotes.get(name)?.0.first()?;
        let mut longest: Option<(usize, &[u8])> = None;
        for (base, prefixes) in &self.rewrites {
            for prefix in prefixes {
                if url.starts_with(prefix) && longest.is_none_or(|(length, _)| length < prefix.len()) {
                    longest = Some((prefix.len(), base));
                }
            }
        }
        let url = match longest {
            Some((length, base)) => [base, &url[length..]].concat(),
            None => url.clone(),
        };
        Some(String::from_utf8_lossy(&url).into_owned())
    }
}

/// `git remote get-url -- <name>` in process (builtin/remote.c `get_url`). Git exits 2 unless the remote
/// is `configured_in_repo`: a key in local or worktree config, or — only while it has no config URL —
/// a `.git/remotes` or `.git/branches` file (`read_remotes_file`, `read_branches_file`). A remote with
/// neither is answered as missing; legacy files and a configured remote without URLs (which falls back
/// to its name) are left to git (`None`).
pub fn fetch_url_in_process(repo: &Path, name: &str) -> Option<Option<String>> {
    if name.is_empty() || name.starts_with('/') || name.contains('\\') {
        return None;
    }
    let repo = gix::open(repo).ok()?;
    let config = RemoteConfig::read(&repo)?;
    let (urls, in_repo) = config.remotes.get(name).map_or((&[][..], false), |(urls, in_repo)| (&urls[..], *in_repo));
    if in_repo {
        return if urls.is_empty() { None } else { Some(config.first_url(name)) };
    }
    if urls.is_empty() && has_legacy_remote(&repo, name) { None } else { Some(None) }
}

/// A `.git/remotes/<name>` or `.git/branches/<name>` file git may read for this remote.
pub(crate) fn has_legacy_remote(repo: &gix::Repository, name: &str) -> bool {
    [repo.common_dir(), repo.git_dir()]
        .iter()
        .any(|dir| ["remotes", "branches"].iter().any(|kind| dir.join(kind).join(name).symlink_metadata().is_ok()))
}

/// `git remote` in process (builtin/remote.c `show_all`): every remote that has any key in any config
/// scope, sorted and deduplicated.
pub fn names_in_process(repo: &Path) -> Option<Vec<String>> {
    Some(RemoteConfig::read(&gix::open(repo).ok()?)?.remotes.into_keys().collect())
}

pub fn names_via_git(repo: &Path) -> Result<String, String> {
    let output = Git::new(Some(repo)).arg("remote").output()?;
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Desktop `getRemotes` in process: names that have a config URL, each with `ls-remote --get-url`.
pub fn list_in_process(repo: &Path) -> Option<Vec<(String, String)>> {
    let config = RemoteConfig::read(&gix::open(repo).ok()?)?;
    config
        .remotes
        .iter()
        .filter(|(_, (urls, _))| !urls.is_empty())
        .map(|(name, _)| Some((name.clone(), config.first_url(name)?)))
        .collect()
}

pub fn get_url_via_git(repo: &Path, name: &str) -> Result<Option<String>, String> {
    let output = Git::new(Some(repo)).args(["remote", "get-url", "--", name]).output()?;
    match output.status.code() {
        Some(0) => Ok(Some(strip_lf(&output.stdout))),
        Some(2) => Ok(None),
        _ => {
            let error = crate::git::stderr_of(&output);
            if error.contains("not a git repository") { Ok(None) } else { Err(error) }
        }
    }
}

fn strip_lf(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes.strip_suffix(b"\n").unwrap_or(bytes)).into_owned()
}

/// Creation must open the repository Git will actually push to, including pushInsteadOf.
pub fn push_url(repo: &Path, name: &str) -> Result<String, String> {
    let urls = push_urls(repo, name)?;
    if urls.len() != 1 {
        return Err("PR creation requires one push URL; select a remote with a single destination".into());
    }
    Ok(urls[0].clone())
}

pub fn push_urls(repo: &Path, name: &str) -> Result<Vec<String>, String> {
    let output = Git::new(Some(repo)).args(["remote", "get-url", "--push", "--all", "--", name]).output()?;
    if !output.status.success() {
        return Err(crate::git::stderr_of(&output));
    }
    let text = strip_lf(&output.stdout);
    let urls: Vec<String> = text.lines().map(str::to_owned).collect();
    if urls.is_empty() || urls.iter().any(String::is_empty) {
        return Err("Remote has no push destination".into());
    }
    Ok(urls)
}

/// Rules apply to the tracked remote branch; a local rename must not change that target.
pub fn branch_target(repo: &Path, name: &str) -> Result<Option<(String, String)>, String> {
    let reference = format!("refs/heads/{name}");
    let branches = crate::branch::list(repo, Some(&reference))?;
    if let Some(branch) = branches.iter().find(|branch| branch.reference == reference)
        && let Some(remote) = branch.upstream_remote_name.as_deref()
    {
        if remote == "." {
            return Ok(None);
        }
        return Ok(get_url(repo, remote)?
            .map(|url| (url, branch.upstream_without_remote.clone().unwrap_or_else(|| name.into()))));
    }
    let remotes = list(repo)?;
    Ok(remotes
        .iter()
        .find(|(remote, _)| remote == "origin")
        .or(remotes.first())
        .map(|(_, url)| (url.clone(), name.into())))
}

pub fn list(repo: &Path) -> Result<Vec<(String, String)>, String> {
    if let Some(remotes) = list_in_process(repo) {
        return Ok(remotes);
    }
    list_via_git(repo)
}

pub fn list_via_git(repo: &Path) -> Result<Vec<(String, String)>, String> {
    let check = Git::new(Some(repo)).args(["rev-parse", "--git-dir"]).output()?;
    if !check.status.success() {
        let error = crate::git::stderr_of(&check);
        return if error.contains("not a git repository") { Ok(vec![]) } else { Err(error) };
    }
    let config = Git::new(Some(repo)).args(["config", "--null", "--get-regexp", r"^remote\..+\.url$"]).output()?;
    if !matches!(config.status.code(), Some(0 | 1)) {
        return Err(crate::git::stderr_of(&config));
    }
    let text = String::from_utf8_lossy(&config.stdout);
    let mut names = BTreeSet::new();
    for entry in text.split_terminator('\0') {
        let (key, value) = entry.split_once('\n').ok_or("Remote URL configuration is missing a value")?;
        let name =
            key.strip_prefix("remote.").and_then(|key| key.strip_suffix(".url")).ok_or("Malformed remote URL key")?;
        if value.is_empty() {
            names.remove(name);
        } else {
            names.insert(name.to_string());
        }
    }
    let mut remotes = Vec::new();
    for name in names {
        let output = Git::new(Some(repo))
            .args(["-c", "transfer.credentialsInUrl=allow", "ls-remote", "--get-url", "--", &name])
            .output()?;
        if !output.status.success() {
            return Err(crate::git::stderr_of(&output));
        }
        remotes.push((name, strip_lf(&output.stdout)));
    }
    Ok(remotes)
}

pub fn update_head(repo: &Path, name: &str, token: Option<&str>, user: Option<&str>) -> Result<(), String> {
    let output = Git::new(Some(repo))
        .args(["remote", "set-head", "-a", "--", name])
        .with_optional_token(token, user)
        .output()?;
    match output.status.code() {
        Some(0 | 1 | 128) => Ok(()),
        _ => Err(crate::git::stderr_of(&output)),
    }
}

/// Remote default branch name, preserving the original Desktop namespace check.
pub fn head(repo: &Path, remote: &str) -> Result<Option<String>, String> {
    let namespace = format!("refs/remotes/{remote}/");
    let output = Git::new(Some(repo)).args(["symbolic-ref", "-q", &format!("{namespace}HEAD")]).output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8_lossy(&output.stdout);
    Ok(value.trim().strip_prefix(&namespace).filter(|name| !name.is_empty()).map(str::to_owned))
}

#[cfg(test)]
mod workflow_tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        Git::new(Some(dir.path())).args(["init", "-q", "-b", "main"]).run().unwrap();
        Git::new(Some(dir.path()))
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "base",
            ])
            .run()
            .unwrap();
        dir
    }

    /// Every answer from the in-process path must equal `git remote get-url` byte for byte.
    #[test]
    fn 进程内_get_url_与_git_逐字节一致() {
        let config = |repo: &Path, args: &[&str]| {
            Git::new(Some(repo)).arg("config").args(args).run().unwrap();
        };
        type Setup = fn(&Path, &dyn Fn(&Path, &[&str]));
        // (remote name, answered in process)
        type Names = &'static [(&'static str, bool)];
        let cases: Vec<(&str, Setup, Names)> = vec![
            (
                "plain",
                |r, c| c(r, &["remote.origin.url", "git@git.example:team/app.git"]),
                &[("origin", true), ("missing", true)],
            ),
            (
                "first of many",
                |r, c| {
                    c(r, &["--add", "remote.origin.url", "https://one.example/a.git"]);
                    c(r, &["--add", "remote.origin.url", "https://two.example/a.git"]);
                },
                &[("origin", true)],
            ),
            (
                "empty resets",
                |r, c| {
                    c(r, &["--add", "remote.origin.url", "https://one.example/a.git"]);
                    c(r, &["--add", "remote.origin.url", ""]);
                    c(r, &["--add", "remote.origin.url", "https://two.example/a.git"]);
                },
                &[("origin", false)],
            ),
            (
                "longest insteadOf wins",
                |r, c| {
                    c(r, &["remote.origin.url", "gh:team/sub/app"]);
                    c(r, &["url.https://short.example/.insteadOf", "gh:"]);
                    c(r, &["url.https://long.example/x/.insteadOf", "gh:team/"]);
                    c(r, &["url.https://push.example/.pushInsteadOf", "gh:team/sub/"]);
                },
                &[("origin", true)],
            ),
            (
                "tie keeps first base",
                |r, c| {
                    c(r, &["remote.origin.url", "gh:app"]);
                    c(r, &["url.https://first.example/.insteadOf", "gh:"]);
                    c(r, &["url.https://second.example/.insteadOf", "gh:"]);
                },
                &[("origin", true)],
            ),
            (
                "base listed twice",
                |r, c| {
                    c(r, &["--add", "url.https://a.example/.insteadOf", "x:"]);
                    c(r, &["--add", "url.https://b.example/.insteadOf", "xy:"]);
                    c(r, &["--add", "url.https://a.example/.insteadOf", "xyz:"]);
                    c(r, &["remote.origin.url", "xyz:repo"]);
                },
                &[("origin", true)],
            ),
            (
                "fetch only uses name",
                |r, c| c(r, &["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]),
                &[("origin", false)],
            ),
            (
                "case of section and key",
                |r, _| {
                    let path = r.join(".git/config");
                    let mut text = std::fs::read_to_string(&path).unwrap();
                    text.push_str("[REMOTE \"origin\"]\n\tURL = https://case.example/a.git\n[remote \"Origin\"]\n\turl = https://other.example/b.git\n");
                    std::fs::write(path, text).unwrap();
                },
                &[("origin", true), ("Origin", true)],
            ),
            (
                "included config",
                |r, c| {
                    std::fs::write(
                        r.join(".git/extra"),
                        "[remote \"origin\"]\n\turl = https://included.example/a.git\n",
                    )
                    .unwrap();
                    c(r, &["include.path", "extra"]);
                },
                &[("origin", true)],
            ),
            (
                "credentials policy",
                |r, c| {
                    c(r, &["remote.origin.url", "https://user:secret@cred.example/a.git"]);
                    c(r, &["transfer.credentialsInUrl", "warn"]);
                },
                &[("origin", false)],
            ),
            (
                "legacy remotes file",
                |r, _| {
                    std::fs::create_dir_all(r.join(".git/remotes")).unwrap();
                    std::fs::write(r.join(".git/remotes/legacy"), "URL: https://legacy.example/a.git\n").unwrap();
                },
                &[("legacy", false), ("missing", true)],
            ),
            (
                "leading slash name",
                |r, c| c(r, &["remote.origin.url", "https://x.example/a.git"]),
                &[("/origin", false)],
            ),
            (
                "legacy branches file beside config urls",
                |r, c| {
                    std::fs::create_dir_all(r.join(".git/branches")).unwrap();
                    std::fs::write(r.join(".git/branches/old"), "https://branches.example/a.git#main\n").unwrap();
                    c(r, &["remote.origin.url", "https://origin.example/a.git"]);
                },
                &[("old", false), ("origin", true)],
            ),
            (
                "several remotes",
                |r, c| {
                    c(r, &["remote.upstream.url", "https://up.example/a.git"]);
                    c(r, &["remote.my.fork.url", "git@fork.example:me/a.git"]);
                    c(r, &["remote.origin.url", "https://origin.example/a.git"]);
                    c(r, &["remote.fetchonly.fetch", "+refs/heads/*:refs/remotes/fetchonly/*"]);
                },
                &[("upstream", true), ("my.fork", true), ("fetchonly", false)],
            ),
        ];
        for (label, setup, names) in cases {
            let dir = fixture();
            let repo = dir.path();
            setup(repo, &config);
            for (name, answered) in names {
                let fast = fetch_url_in_process(repo, name);
                assert_eq!(fast.is_some(), *answered, "{label}/{name}: in process {fast:?}");
                let git = get_url_via_git(repo, name);
                if let Some(fast) = fast {
                    assert_eq!(Ok(fast), git, "{label}/{name}");
                }
                assert_eq!(get_url(repo, name), git, "{label}/{name}: combined");
            }
            let git = names_via_git(repo).unwrap();
            if let Some(fast) = names_in_process(repo) {
                assert_eq!(fast.iter().map(|name| format!("{name}\n")).collect::<String>(), git, "{label}: names");
            }
            let git = list_via_git(repo);
            if let Some(fast) = list_in_process(repo) {
                assert_eq!(Ok(fast), git, "{label}: list");
            }
            assert_eq!(list(repo), git, "{label}: combined list");
        }
    }

    #[test]
    fn push_destination_uses_pushurl_and_push_instead_of() {
        let dir = fixture();
        let repo = dir.path();
        Git::new(Some(repo)).args(["remote", "add", "origin", "https://read.example/upstream/repo.git"]).run().unwrap();
        Git::new(Some(repo))
            .args(["config", "url.https://write.example/.pushInsteadOf", "https://read.example/"])
            .run()
            .unwrap();
        assert_eq!(push_url(repo, "origin").unwrap(), "https://write.example/upstream/repo.git");
        Git::new(Some(repo))
            .args(["remote", "set-url", "--push", "origin", "https://fork.example/me/repo.git"])
            .run()
            .unwrap();
        assert_eq!(push_url(repo, "origin").unwrap(), "https://fork.example/me/repo.git");
        assert_eq!(get_url(repo, "origin").unwrap().unwrap(), "https://read.example/upstream/repo.git");
        Git::new(Some(repo))
            .args(["remote", "set-url", "--push", "--add", "origin", "https://mirror.example/me/repo.git"])
            .run()
            .unwrap();
        assert!(push_url(repo, "origin").is_err(), "creation must never choose one of multiple destinations silently");
        assert_eq!(push_urls(repo, "origin").unwrap().len(), 2);
    }

    #[test]
    fn policy_follows_the_tracked_remote_and_remote_branch_name() {
        let dir = fixture();
        let repo = dir.path();
        for (name, url) in
            [("origin", "https://github.com/me/fork.git"), ("upstream", "https://github.com/org/repo.git")]
        {
            Git::new(Some(repo)).args(["remote", "add", name, url]).run().unwrap();
        }
        Git::new(Some(repo)).args(["update-ref", "refs/remotes/upstream/release", "HEAD"]).run().unwrap();
        Git::new(Some(repo)).args(["branch", "--set-upstream-to", "upstream/release", "main"]).run().unwrap();
        assert_eq!(
            branch_target(repo, "main").unwrap(),
            Some(("https://github.com/org/repo.git".into(), "release".into()))
        );
        assert_eq!(
            branch_target(repo, "new-feature").unwrap(),
            Some(("https://github.com/me/fork.git".into(), "new-feature".into()))
        );
        Git::new(Some(repo)).args(["config", "branch.main.remote", "."]).run().unwrap();
        assert_eq!(branch_target(repo, "main").unwrap(), None);
    }
}
