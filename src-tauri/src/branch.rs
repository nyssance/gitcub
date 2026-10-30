//! 分支与克隆。git 参数照搬 GitHub Desktop 的 lib/git/{branch,clone,checkout}.ts。

use crate::git::Git;
use std::path::Path;

/// 创建分支。`start_point` 为 None 则从当前 HEAD 分出。
///
/// 照搬原版 createBranch：从远端分支直接分出时要 `--no-track`，
/// 否则后续会把那个远端分支的上游当成推送目标（fork 场景下往往是上游仓库）。
pub fn create(repo: &Path, name: &str, start_point: Option<&str>, no_track: bool) -> Result<(), String> {
    let mut g = Git::new(Some(repo)).arg("branch");
    if no_track {
        g = g.arg("--no-track");
    }
    g = g.args(["--", name]);
    if let Some(sp) = start_point {
        g = g.arg(sp);
    }
    g.run()
}

/// 删除本地分支。原版 deleteLocalBranch 用的就是 `-D`（强制）。
pub fn delete_local(repo: &Path, name: &str) -> Result<(), String> {
    Git::new(Some(repo)).args(["branch", "-D", "--", name]).run()
}

/// 删除远端分支：推一个空 refspec 过去。
pub fn delete_remote(repo: &Path, remote: &str, name: &str, token: Option<&str>) -> Result<(), String> {
    let out = Git::new(Some(repo))
        .args(["push", "--", remote, &format!(":{name}")])
        .with_optional_token(token, None)
        .output()?;
    if out.status.success() {
        return Ok(());
    }
    let error = crate::git::stderr_of(&out);
    // Desktop deleteRemoteBranch: a removed upstream must prune the stale local ref.
    if error.contains("remote ref does not exist") {
        return Git::new(Some(repo)).args(["update-ref", "-d", &format!("refs/remotes/{remote}/{name}")]).run();
    }
    Err(error)
}

/// 把一个文件挪进废纸篓。
///
/// macOS 上显式选 NSFileManager，不用 trash 默认的 Finder：后者是拿
/// osascript 去驱动 Finder 的——第一次会弹「GitCub 想要控制 Finder」的授权框，
/// 而且是异步的（文件可能在我们把内容恢复回来之后才被删掉）。
/// Electron 的 `shell.trashItem`（原版用的那个）走的也是 NSFileManager。
fn to_trash(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let r = {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(path)
    };
    #[cfg(not(target_os = "macos"))]
    let r = trash::delete(path);
    r.map_err(|e| format!("移到废纸篓失败: {e}"))
}

/// 要丢弃的一条改动。比一个路径多两样东西：改动类型（决定要不要挪废纸篓）、
/// 旧路径（重命名在 index 里是两条记录，只处理新路径的话丢不干净）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardFile {
    pub path: String,
    pub old_path: Option<String>,
    pub change: crate::status::ChangeType,
    /// 是子模块。它要走 `submodule update`，不能挪废纸篓——那会把整个
    /// 子模块工作树扔掉，里面没提交的东西一并没了。
    #[serde(default)]
    pub submodule: bool,
}

/// 丢弃工作区改动。照搬原版 GitStore.discardChanges 的三步：
///
///   1. 先把文件挪进**废纸篓**（删除类的除外——工作区里本来就没了）
///   2. `git reset` 这些路径，让 index 回到 HEAD 的样子
///   3. `git checkout-index` 把还在 index 里的路径写回工作区
///
/// 第一步是关键：未跟踪文件不在 git 里，直接 unlink 就真的没了；挪进废纸篓
/// 用户还能捞回来。第二三步合起来才能处理重命名——它在 index 里是「旧路径
/// 删除 + 新路径新增」两条，旧路径也要一起复位并检出，否则文件名回不去。
///
/// 用 `checkout-index --stdin -z` 而不是 `checkout HEAD -- <paths>`：前者对
/// 不在 index 里的路径不报错（未跟踪文件正是如此），路径也不进 argv，
/// 一次丢几千个文件不会撞上命令行长度上限。
pub fn discard(repo: &Path, files: &[DiscardFile]) -> Result<(), String> {
    use crate::status::ChangeType;
    if files.is_empty() {
        return Ok(());
    }

    let mut paths: Vec<String> = Vec::new();
    let mut submodules: Vec<String> = Vec::new();
    for f in files {
        if f.submodule {
            // 子模块的「丢弃」= 把它复位到父仓库记录的那个提交（原版
            // resetSubmodulePaths 也是这条命令）。注意**不能**先挪废纸篓：
            // 那等于把整个子模块工作树连同里面没提交的东西一起扔掉。
            submodules.push(f.path.clone());
            continue;
        }
        // 删除类的文件工作区里已经没有了，没什么可挪的
        if f.change != ChangeType::Deleted {
            let full = repo.join(&f.path);
            if full.exists() {
                to_trash(&full)?;
            }
        }
        paths.push(f.path.clone());
        if let Some(old) = &f.old_path {
            paths.push(old.clone());
        }
    }

    crate::ops::reset_submodules(repo, &submodules)?;
    if paths.is_empty() {
        return Ok(());
    }

    crate::ops::reset_paths(repo, crate::ops::ResetMode::Mixed, "HEAD", &paths)?;

    let mut stdin = paths.join("\0");
    stdin.push('\0');
    let out = Git::new(Some(repo)).args(["checkout-index", "-f", "-u", "-q", "--stdin", "-z"]).stdin(stdin).output()?;
    // 退出码 1 = 有路径不在 index 里（未跟踪文件就是），不是错误
    match out.status.code() {
        Some(0 | 1) => Ok(()),
        _ => Err(crate::git::stderr_of(&out)),
    }
}

/// 克隆时禁用的传输协议。
///
/// 照搬原版：`ext::` 让 URL 里能塞任意命令交给 shell 执行，是远程代码执行面。
/// 新仓库的默认分支。原版是设置项 `getDefaultBranch()`，默认就是 main。
const DEFAULT_BRANCH: &str = "main";

const UNSUPPORTED_PROTOCOLS: &[&str] = &["ext", "ext.exe"];

/// 目标路径是否落在不该被克隆覆盖的敏感位置。
///
/// 照搬原版 isClonePathSensitive：防的是 URL 被构造后诱导界面算出一个
/// 越界的克隆路径（路径穿越）。
fn is_path_sensitive(path: &Path) -> bool {
    let Some(home) = dirs_home() else {
        return false;
    };
    let target = path.to_string_lossy().to_lowercase();
    let home_s = home.to_string_lossy().to_lowercase();

    if target == home_s {
        return true;
    }

    let mut sensitive = vec![
        home.join(".ssh"),
        home.join(".gnupg"),
        home.join(".config"),
        home.join(".config").join("git"),
        home.join(".gitconfig"),
    ];
    if cfg!(windows)
        && let Ok(appdata) = std::env::var("APPDATA")
    {
        sensitive.push(std::path::PathBuf::from(&appdata));
        sensitive.push(std::path::PathBuf::from(appdata).join("gnupg"));
    }

    sensitive.iter().any(|s| {
        let s = s.to_string_lossy().to_lowercase();
        target == s || target.starts_with(&format!("{s}{}", std::path::MAIN_SEPARATOR))
    })
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(std::path::PathBuf::from)
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneOptions {
    pub branch: Option<String>,
    pub default_branch: Option<String>,
}

pub fn clone(url: &str, path: &Path, token: Option<&str>) -> Result<(), String> {
    let output = clone_output(url, path, token, &CloneOptions::default())?;
    if output.status.success() { Ok(()) } else { Err(crate::git::stderr_of(&output)) }
}

pub fn clone_output(
    url: &str, path: &Path, token: Option<&str>, options: &CloneOptions,
) -> Result<std::process::Output, String> {
    clone_output_stream(url, path, token, options, |_| {})
}

pub fn clone_output_stream(
    url: &str, path: &Path, token: Option<&str>, options: &CloneOptions,
    on_progress: impl FnMut(crate::progress::Progress),
) -> Result<std::process::Output, String> {
    if let Some(protocol) = UNSUPPORTED_PROTOCOLS.iter().find(|protocol| url.starts_with(&format!("{protocol}::"))) {
        return Err(format!("The \"{protocol}\" transport is not supported for cloning in GitCub."));
    }
    // Normalize nonexistent destinations too; canonicalize the nearest existing
    // ancestor so a symlink cannot bypass sensitive-directory checks.
    let absolute = std::path::absolute(path).map_err(|e| e.to_string())?;
    let mut normalized = std::path::PathBuf::new();
    for part in absolute.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(part.as_os_str()),
        }
    }
    let mut ancestor = normalized.as_path();
    let mut suffix = vec![];
    while !ancestor.exists() {
        if let Some(name) = ancestor.file_name() {
            suffix.push(name.to_os_string());
        }
        let Some(parent) = ancestor.parent() else {
            break;
        };
        ancestor = parent;
    }
    let mut resolved = ancestor.canonicalize().map_err(|e| e.to_string())?;
    for part in suffix.iter().rev() {
        resolved.push(part);
    }
    if is_path_sensitive(&normalized) || is_path_sensitive(&resolved) {
        return Err(format!(
            "The clone destination \"{}\" targets a sensitive system location. Cloning into this directory is not allowed.",
            path.display()
        ));
    }
    let mut git = Git::new(None)
        .args(["-c", &format!("init.defaultBranch={}", options.default_branch.as_deref().unwrap_or(DEFAULT_BRANCH))])
        .args(["-c", "protocol.ext.allow=never", "-c", "protocol.ext.exe.allow=never"])
        .args(["clone", "--recursive", "--progress"])
        .env("GIT_CLONE_PROTECTION_ACTIVE", "false");
    if let Ok(allow) = std::env::var("GIT_ALLOW_PROTOCOL") {
        git = git.env(
            "GIT_ALLOW_PROTOCOL",
            allow.split(':').filter(|protocol| !UNSUPPORTED_PROTOCOLS.contains(protocol)).collect::<Vec<_>>().join(":"),
        );
    }
    if let Some(branch) = &options.branch {
        git = git.args(["-b", branch]);
    }
    git = git.args(["--", url]).arg(&resolved);
    if let Some(token) = token {
        git = git.with_token(token, None);
    }
    let mut progress = crate::progress::CloneStream::new(on_progress);
    let output = git.output_raw_stream(|chunk| progress.push(chunk))?;
    progress.finish();
    Ok(output)
}

/// Desktop refs.ts: qualify local refs before passing them to revision consumers.
pub fn local_ref(name: &str) -> String {
    if name.starts_with("refs/heads/") {
        name.into()
    } else if name.starts_with("heads/") {
        format!("refs/{name}")
    } else {
        format!("refs/heads/{name}")
    }
}

pub fn symbolic_ref(repo: &Path, name: &str) -> Result<Option<String>, String> {
    let out = Git::new(Some(repo)).args(["symbolic-ref", "-q", "--", name]).output()?;
    match out.status.code() {
        Some(0) => Ok(Some(String::from_utf8_lossy(&out.stdout).trim().into())),
        Some(1 | 128) => Ok(None),
        _ => Err(crate::git::stderr_of(&out)),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub name_without_remote: String,
    pub upstream: Option<String>,
    pub upstream_ref: Option<String>,
    pub upstream_remote_name: Option<String>,
    pub upstream_without_remote: Option<String>,
    pub remote_name: Option<String>,
    pub sha: String,
    pub reference: String,
    pub remote: bool,
}

/// 按最长的已配置远端拆分 `refs/remotes/` 之下的「远端/分支」名（与 GitLens `splitRemoteBranchName`
/// 同一规则）：远端必须是完整路径段，分支部分不能为空；都不匹配时返回 None，由调用方决定回退。
pub fn split_remote_branch_name<'a>(name: &'a str, remotes: &[&str]) -> Option<(&'a str, &'a str)> {
    remotes
        .iter()
        .filter_map(|remote| Some((remote.len(), name.strip_prefix(remote)?.strip_prefix('/')?)))
        .filter(|(_, branch)| !branch.is_empty())
        .max_by_key(|(len, _)| *len)
        .map(|(len, branch)| (&name[..len], branch))
}

/// Uses canonical ref names so refs beginning with '-' never become Git options.
pub fn list(repo: &Path, pattern: Option<&str>) -> Result<Vec<BranchInfo>, String> {
    let text = match records_in_process(repo, pattern) {
        Some(text) => text,
        None => match records_via_git(repo, pattern)? {
            Some(text) => text,
            None => return Ok(Vec::new()),
        },
    };
    // A configured remote can contain '/', notably a GitLab fork namespace.
    // Match the longest configured prefix instead of splitting at the first slash.
    let remote_text = match crate::remote_ops::names_in_process(repo) {
        Some(names) => names.join("\n"),
        None => crate::remote_ops::names_via_git(repo)?,
    };
    let remote_names: Vec<_> = remote_text.lines().collect();
    Ok(parse_records(&text, &remote_names))
}

const RECORD_FORMAT: &str =
    "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(symref)";

/// `None` outside a repository, as Desktop treats that error.
pub fn records_via_git(repo: &Path, pattern: Option<&str>) -> Result<Option<String>, String> {
    let mut command = Git::new(Some(repo)).args(["for-each-ref", RECORD_FORMAT, "--"]);
    if let Some(pattern) = pattern {
        command = command.arg(pattern);
    } else {
        command = command.args(["refs/heads/", "refs/remotes/"]);
    }
    let output = command.output()?;
    if !output.status.success() {
        let error = crate::git::stderr_of(&output);
        if error.contains("not a git repository") {
            return Ok(None);
        }
        return Err(error);
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

/// The non-symbolic rows of `for-each-ref` with `RECORD_FORMAT`, in process: refs sorted by name, matched
/// as path prefixes (ref-filter.c `match_name_as_path`), and the upstream fields as `branch_get_upstream`
/// and `fill_remote_ref_details` derive them — `branch.<name>.remote` (last value), the first
/// `branch.<name>.merge`, mapped through that remote's fetch refspecs (refspec.c `refspec_find_match`,
/// first match wins). Symbolic refs are omitted because `list` drops them. A `.` remote (resolved with
/// `dwim_ref`), legacy remote files, empty or implicit values, negative or unusual refspecs, glob
/// patterns and unreadable refs are left to git (`None`).
pub fn records_in_process(repo: &Path, pattern: Option<&str>) -> Option<String> {
    let patterns: Vec<&str> = pattern.map_or_else(|| vec!["refs/heads/", "refs/remotes/"], |pattern| vec![pattern]);
    if patterns.iter().any(|pattern| pattern.is_empty() || pattern.contains(['*', '?', '[', '\\'])) {
        return None;
    }
    let repo = gix::open(repo).ok()?;
    let config = BranchConfig::read(&repo)?;
    let references = repo.references().ok()?;
    // Iterate only the requested prefixes, as the files backend does for `for-each-ref refs/heads/
    // refs/remotes/`: loose refs are one file each, and a fresh clone keeps every tag loose.
    let mut rows = Vec::new();
    for reference in patterns
        .iter()
        .map(|pattern| references.prefixed(*pattern).ok())
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .flatten()
    {
        let reference = reference.ok()?;
        let name = reference.name().as_bstr().to_vec();
        let matched = patterns.iter().any(|pattern| {
            name.starts_with(pattern.as_bytes())
                && (name.len() == pattern.len() || name[pattern.len()] == b'/' || pattern.ends_with('/'))
        });
        if !matched {
            continue;
        }
        let gix::refs::TargetRef::Object(id) = reference.target() else { continue };
        let (upstream, remote, merge) = match name.strip_prefix(b"refs/heads/") {
            Some(branch) => config.upstream(&repo, branch)?,
            None => Default::default(),
        };
        let mut row = name.clone();
        for field in [id.to_string().into_bytes(), upstream, remote, merge] {
            row.push(0);
            row.extend(field);
        }
        row.extend(b"\0\n");
        rows.push((name, row));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    Some(String::from_utf8_lossy(&rows.into_iter().flat_map(|(_, row)| row).collect::<Vec<_>>()).into_owned())
}

/// A fetch refspec: (source, destination, is pattern).
type Refspec = (Vec<u8>, Vec<u8>, bool);
/// `branch.<name>.remote` (last value) and `branch.<name>.merge` values in order.
type Tracking = (Option<Vec<u8>>, Vec<Vec<u8>>);

/// Branch tracking configuration as remote.c `handle_config` collects it.
struct BranchConfig {
    /// remote name → fetch refspecs in config order
    fetch: std::collections::HashMap<Vec<u8>, Vec<Refspec>>,
    branches: std::collections::HashMap<Vec<u8>, Tracking>,
}

impl BranchConfig {
    fn read(repo: &gix::Repository) -> Option<Self> {
        let config = repo.config_snapshot();
        let mut fetch = std::collections::HashMap::<Vec<u8>, Vec<Refspec>>::new();
        let mut branches = std::collections::HashMap::<Vec<u8>, Tracking>::new();
        for section in config.plumbing().sections() {
            let header = section.header();
            let Some(subsection) = header.subsection_name() else { continue };
            if header.name().eq_ignore_ascii_case(b"remote") {
                // handle_config ignores remote names starting with '/'.
                if subsection.starts_with(b"/") {
                    continue;
                }
                for value in section.values("fetch") {
                    let refspec = simple_refspec(value.as_ref())?;
                    fetch.entry(subsection.to_vec()).or_default().push(refspec);
                }
            } else if header.name().eq_ignore_ascii_case(b"branch") {
                if subsection.is_empty() {
                    return None;
                }
                let remotes = section.values("remote");
                let merges = section.values("merge");
                if remotes.iter().chain(&merges).any(|value| value.is_empty()) {
                    return None;
                }
                let entry = branches.entry(subsection.to_vec()).or_default();
                if let Some(remote) = remotes.last() {
                    entry.0 = Some(remote.to_vec());
                }
                entry.1.extend(merges.iter().map(|merge| merge.to_vec()));
            }
        }
        Some(Self { fetch, branches })
    }

    /// (`%(upstream)`, `%(upstream:remotename)`, `%(upstream:remoteref)`), empty without an upstream.
    fn upstream(&self, repo: &gix::Repository, branch: &[u8]) -> Option<(Vec<u8>, Vec<u8>, Vec<u8>)> {
        let Some((Some(remote), merges)) = self.branches.get(branch) else { return Some(Default::default()) };
        let Some(merge) = merges.first() else { return Some(Default::default()) };
        if remote == b"."
            || std::str::from_utf8(remote).is_ok_and(|name| crate::remote_ops::has_legacy_remote(repo, name))
        {
            return None;
        }
        let tracking = self.fetch.get(remote).into_iter().flatten().find_map(|(source, destination, pattern)| {
            if !pattern {
                return (merge == source).then(|| destination.clone());
            }
            let star = source.iter().position(|&b| b == b'*')?;
            let (prefix, suffix) = (&source[..star], &source[star + 1..]);
            if !merge.starts_with(prefix) || merge.len() < prefix.len() + suffix.len() || !merge.ends_with(suffix) {
                return None;
            }
            let middle = &merge[prefix.len()..merge.len() - suffix.len()];
            let star = destination.iter().position(|&b| b == b'*')?;
            Some([&destination[..star], middle, &destination[star + 1..]].concat())
        });
        Some(match tracking {
            Some(upstream) => (upstream, remote.clone(), merge.clone()),
            None => Default::default(),
        })
    }
}

/// `[+]refs/…:refs/…` with either one `*` on each side or none; anything else is left to git.
fn simple_refspec(value: &[u8]) -> Option<Refspec> {
    let value = value.strip_prefix(b"+").unwrap_or(value);
    let colon = value.iter().position(|&b| b == b':')?;
    let (source, destination) = (&value[..colon], &value[colon + 1..]);
    let plain = |side: &[u8]| {
        side.starts_with(b"refs/")
            && side.iter().all(|&b| b.is_ascii_alphanumeric() || b"-_./*".contains(&b))
            && !side.windows(2).any(|pair| pair == b".." || pair == b"//" || pair == b"/.")
            && !side.ends_with(b"/")
            && !side.ends_with(b".")
            && !side.ends_with(b".lock")
    };
    let stars = |side: &[u8]| side.iter().filter(|&&b| b == b'*').count();
    if !plain(source) || !plain(destination) || stars(source) > 1 || stars(source) != stars(destination) {
        return None;
    }
    Some((source.to_vec(), destination.to_vec(), stars(source) == 1))
}

fn parse_records(text: &str, remote_names: &[&str]) -> Vec<BranchInfo> {
    let remote_names = remote_names.to_vec();
    let mut branches = Vec::new();
    for line in text.lines() {
        let f: Vec<_> = line.split('\0').collect();
        if f.len() != 6 || !f[5].is_empty() {
            continue;
        }
        let (name, remote) = if let Some(name) = f[0].strip_prefix("refs/heads/") {
            (name, false)
        } else if let Some(name) = f[0].strip_prefix("refs/remotes/") {
            (name, true)
        } else {
            continue;
        };
        // 没有已配置的远端匹配时退回第一段（远端已删、只剩跟踪引用）。
        let (remote_name, short) = if remote {
            let (remote_name, short) = split_remote_branch_name(name, &remote_names)
                .unwrap_or_else(|| name.split_once('/').unwrap_or((name, name)));
            (Some(remote_name.to_string()), short)
        } else {
            (None, name)
        };
        branches.push(BranchInfo {
            name: name.into(),
            name_without_remote: short.into(),
            remote_name,
            remote,
            sha: f[1].into(),
            reference: f[0].into(),
            upstream: (!f[2].is_empty()).then(|| {
                f[2].strip_prefix("refs/remotes/").or_else(|| f[2].strip_prefix("refs/heads/")).unwrap_or(f[2]).into()
            }),
            upstream_ref: (!f[2].is_empty()).then(|| f[2].into()),
            upstream_remote_name: (!f[3].is_empty()).then(|| f[3].into()),
            upstream_without_remote: (!f[4].is_empty())
                .then(|| f[4].strip_prefix("refs/heads/").unwrap_or(f[4]).into()),
        });
    }
    branches
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind")]
pub enum Tip {
    Unborn {
        r#ref: String,
    },
    Detached {
        #[serde(rename = "currentSha")]
        current_sha: String,
    },
    Valid {
        branch: BranchInfo,
    },
}

pub fn tip(repo: &Path) -> Result<Tip, String> {
    if let Some(reference) = symbolic_ref(repo, "HEAD")? {
        let mut branches = list(repo, Some(&local_ref(reference.strip_prefix("refs/heads/").unwrap_or(&reference))))?;
        if let Some(branch) = branches.pop() {
            return Ok(Tip::Valid { branch });
        }
        return Ok(Tip::Unborn { r#ref: reference.strip_prefix("refs/heads/").unwrap_or(&reference).into() });
    }
    Ok(Tip::Detached {
        current_sha: Git::new(Some(repo)).args(["rev-parse", "--verify", "HEAD"]).stdout()?.trim().into(),
    })
}

pub fn pointed_at(repo: &Path, revision: &str) -> Result<Option<Vec<String>>, String> {
    let out = Git::new(Some(repo))
        .args(["branch", &format!("--points-at={revision}"), "--format=%(refname:short)"])
        .output()?;
    match out.status.code() {
        Some(0) => Ok(Some(String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect())),
        Some(1 | 129) => Ok(None),
        _ => Err(crate::git::stderr_of(&out)),
    }
}

/// Desktop checkoutBranch: remote branches create an explicitly tracked local branch.
pub fn checkout(repo: &Path, name: &str, remote_ref: Option<&str>, allow_file_protocol: bool) -> Result<(), String> {
    let mut command = Git::new(Some(repo)).arg("checkout");
    if let Some(reference) = remote_ref {
        command = command.args(["-b", name, reference]);
    } else {
        // Local Git branch names cannot begin with '-'; never let input become an option.
        if name.starts_with('-') {
            return Err("Invalid local branch name".into());
        }
        command = command.arg(name);
    }
    let out = command.arg("--").output()?;
    if !out.status.success() {
        let error = crate::git::stderr_of(&out);
        if error.contains("already exists") {
            return Err("A branch with that name already exists.".into());
        }
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    if repo.join(".gitmodules").exists() {
        Git::new(Some(repo)).args(["submodule", "sync", "--recursive"]).run()?;
        let mut update = Git::new(Some(repo));
        if allow_file_protocol {
            update = update.args(["-c", "protocol.file.allow=always"]);
        }
        update.args(["submodule", "update", "--init", "--recursive"]).run()?;
    }
    Ok(())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingBranch {
    pub r#ref: String,
    pub sha: String,
    pub upstream_ref: String,
    pub upstream_sha: String,
}

/// Desktop getBranchesDifferingFromUpstream: ignore HEAD, symbolic and equal refs.
pub fn differing_from_upstream(repo: &Path) -> Result<Vec<TrackingBranch>, String> {
    let branches = list(repo, None)?;
    let current = symbolic_ref(repo, "HEAD")?;
    let remotes: std::collections::HashMap<_, _> =
        branches.iter().filter(|b| b.remote).map(|b| (b.reference.as_str(), b.sha.as_str())).collect();
    Ok(branches
        .iter()
        .filter(|b| !b.remote && current.as_ref() != Some(&b.reference))
        .filter_map(|b| {
            let upstream_ref = b.upstream_ref.as_ref()?;
            let sha = remotes.get(upstream_ref.as_str())?;
            (*sha != b.sha).then(|| TrackingBranch {
                r#ref: b.reference.clone(),
                sha: b.sha.clone(),
                upstream_ref: upstream_ref.clone(),
                upstream_sha: (*sha).into(),
            })
        })
        .collect())
}

pub fn fast_forward_branches(repo: &Path, branches: &[TrackingBranch]) -> Result<(), String> {
    if branches.is_empty() {
        return Ok(());
    }
    let refs = branches
        .iter()
        .map(|branch| format!("{}:{}", branch.upstream_ref, branch.r#ref))
        .collect::<Vec<_>>()
        .join("\n");
    let output = Git::new(Some(repo))
        .args(["fetch", ".", "--show-forced-updates", "--no-write-fetch-head", "--stdin"])
        .env("GIT_REFLOG_ACTION", "pull")
        .stdin(refs)
        .output()?;
    if matches!(output.status.code(), Some(0 | 1)) { Ok(()) } else { Err(crate::git::stderr_of(&output)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// 测试里直接调 git，不走封装——判定标准应当是 git 自己怎么看。
    fn git(r: &Path, args: &[&str]) -> String {
        let o = Command::new("git").arg("-C").arg(r).args(args).output().unwrap();
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_path_buf();
        git(&r, &["init", "-q", "-b", "main", "."]);
        git(&r, &["config", "user.email", "t@t.t"]);
        git(&r, &["config", "user.name", "t"]);
        std::fs::write(r.join("a.txt"), "1\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "init"]);
        (d, r)
    }

    /// The in-process rows must equal git's `for-each-ref` rows (symbolic refs aside) byte for byte, and
    /// `list` must equal parsing git's rows whether or not the in-process path answered.
    fn assert_records_match(r: &Path, label: &str, patterns: &[Option<&str>], answered: bool) {
        for pattern in patterns {
            let fast = records_in_process(r, *pattern);
            assert_eq!(fast.is_some(), answered, "{label} {pattern:?}: {fast:?}");
            let git = records_via_git(r, *pattern).unwrap().unwrap();
            let git: String = git.lines().filter(|line| line.ends_with('\0')).map(|line| format!("{line}\n")).collect();
            if let Some(fast) = fast {
                assert_eq!(fast, git, "{label} {pattern:?}");
            }
            let fast = serde_json::to_value(list(r, *pattern).unwrap()).unwrap();
            let names = crate::remote_ops::names_via_git(r).unwrap();
            let names: Vec<_> = names.lines().collect();
            assert_eq!(fast, serde_json::to_value(parse_records(&git, &names)).unwrap(), "{label} {pattern:?}");
        }
    }

    #[test]
    fn 进程内分支记录与_git_逐字节一致() {
        let (_d, r) = repo();
        let compare = |label: &str, patterns: &[Option<&str>], answered: bool| {
            assert_records_match(&r, label, patterns, answered);
        };
        let all: &[Option<&str>] = &[None, Some("refs/heads/main"), Some("refs/heads/feature"), Some("refs/remotes/")];
        compare("no remotes", all, true);

        let head = git(&r, &["rev-parse", "HEAD"]);
        let head = head.trim();
        git(&r, &["remote", "add", "origin", "https://example.invalid/a.git"]);
        git(&r, &["remote", "add", "team/fork", "https://example.invalid/b.git"]);
        for name in ["refs/remotes/origin/main", "refs/remotes/origin/feature/x", "refs/remotes/team/fork/dev"] {
            git(&r, &["update-ref", name, head]);
        }
        git(&r, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        git(&r, &["branch", "-q", "--track", "tracking", "origin/main"]);
        git(&r, &["branch", "-q", "feature/x"]);
        git(&r, &["branch", "-q", "--set-upstream-to", "origin/feature/x", "feature/x"]);
        git(&r, &["branch", "-q", "dev"]);
        git(&r, &["config", "branch.dev.remote", "team/fork"]);
        git(&r, &["config", "branch.dev.merge", "refs/heads/dev"]);
        git(&r, &["branch", "-q", "short-merge"]);
        git(&r, &["config", "branch.short-merge.remote", "origin"]);
        git(&r, &["config", "branch.short-merge.merge", "main"]);
        git(&r, &["branch", "-q", "url-remote"]);
        git(&r, &["config", "branch.url-remote.remote", "https://example.invalid/c.git"]);
        git(&r, &["config", "branch.url-remote.merge", "refs/heads/main"]);
        git(&r, &["branch", "-q", "two-merges"]);
        git(&r, &["config", "branch.two-merges.remote", "origin"]);
        git(&r, &["config", "--add", "branch.two-merges.merge", "refs/heads/feature/x"]);
        git(&r, &["config", "--add", "branch.two-merges.merge", "refs/heads/main"]);
        git(&r, &["branch", "-q", "main-sub/leaf"]);
        compare("tracking", all, true);

        git(&r, &["pack-refs", "--all"]);
        git(&r, &["branch", "-q", "after-pack"]);
        compare("packed", all, true);

        git(&r, &["config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/mainline"]);
        git(&r, &["config", "--add", "remote.origin.fetch", "refs/heads/feature/*:refs/remotes/origin/f/*"]);
        git(&r, &["config", "remote.team/fork.fetch", "+refs/heads/*:refs/remotes/team/fork/*"]);
        compare("custom refspecs", all, true);

        git(&r, &["config", "--add", "remote.origin.fetch", "^refs/heads/secret"]);
        compare("negative refspec", &[None], false);
        git(&r, &["config", "--unset", "remote.origin.fetch", "\\^refs/heads/secret"]);

        git(&r, &["branch", "-q", "local-up"]);
        git(&r, &["config", "branch.local-up.remote", "."]);
        git(&r, &["config", "branch.local-up.merge", "refs/heads/main"]);
        compare("dot remote", &[None], false);
        compare("dot remote, other branch", &[Some("refs/heads/main")], true);
    }

    /// Only `refs/heads/` and `refs/remotes/` are read, so the loose/packed overlay inside them must
    /// match git's files backend, and refs elsewhere (tags, notes) must not change the answer.
    #[test]
    fn 进程内分支记录在松散与打包引用混合时与_git_一致() {
        let (_d, r) = repo();
        let all: &[Option<&str>] = &[
            None,
            Some("refs/heads/main"),
            Some("refs/heads/shadow"),
            Some("refs/remotes/"),
            Some("refs/remotes/up/stream"),
        ];
        let first = git(&r, &["rev-parse", "HEAD"]).trim().to_string();
        std::fs::write(r.join("a.txt"), "2\n").unwrap();
        git(&r, &["commit", "-qam", "second"]);
        let second = git(&r, &["rev-parse", "HEAD"]).trim().to_string();
        git(&r, &["remote", "add", "up/stream", "https://example.invalid/u.git"]);
        for (name, id) in [
            ("refs/heads/shadow", &first),
            ("refs/heads/gone", &first),
            ("refs/heads/packed-only", &first),
            ("refs/remotes/up/stream/main", &first),
            ("refs/remotes/up/stream/feature/deep", &second),
        ] {
            git(&r, &["update-ref", name, id]);
        }
        git(&r, &["config", "branch.shadow.remote", "up/stream"]);
        git(&r, &["config", "branch.shadow.merge", "refs/heads/main"]);
        for tag in 0..50 {
            git(&r, &["tag", &format!("v{tag}"), &first]);
        }
        git(&r, &["pack-refs", "--all"]);
        let loose = r.join(".git").join("refs");
        // The same name loose and packed: the loose file wins.
        git(&r, &["update-ref", "refs/heads/shadow", &second]);
        git(&r, &["update-ref", "refs/remotes/up/stream/main", &second]);
        git(&r, &["branch", "-q", "loose-only"]);
        git(&r, &["symbolic-ref", "refs/remotes/up/stream/HEAD", "refs/remotes/up/stream/main"]);
        assert!(loose.join("heads/shadow").is_file() && loose.join("remotes/up/stream/main").is_file());
        assert_records_match(&r, "loose over packed", all, true);

        // A loose file removed behind git's back: the packed value shows again.
        std::fs::write(loose.join("heads/gone"), format!("{second}\n")).unwrap();
        assert_records_match(&r, "loose written directly", all, true);
        std::fs::remove_file(loose.join("heads/gone")).unwrap();
        assert_records_match(&r, "loose removed, packed remains", all, true);
        // Deleted through git: gone from packed-refs too.
        git(&r, &["branch", "-q", "-D", "packed-only"]);
        assert_records_match(&r, "deleted", all, true);

        // A stale lock file is not a ref; a broken tag outside the listed prefixes is never read.
        std::fs::write(loose.join("heads/stale.lock"), format!("{first}\n")).unwrap();
        std::fs::write(loose.join("tags/broken"), "").unwrap();
        assert_records_match(&r, "lock file, broken tag", all, true);

        // Empty or corrupt refs inside the listed prefixes are left to git.
        std::fs::write(loose.join("heads/empty"), "").unwrap();
        assert_records_match(&r, "empty branch ref", &[None, Some("refs/heads/")], false);
        assert_records_match(&r, "empty branch ref, other prefix", &[Some("refs/remotes/")], true);
        std::fs::write(loose.join("heads/empty"), "not a ref\n").unwrap();
        assert_records_match(&r, "corrupt branch ref", &[None], false);
        std::fs::remove_file(loose.join("heads/empty")).unwrap();
        std::fs::write(loose.join("remotes/up/stream/main"), "").unwrap();
        assert_records_match(&r, "empty remote ref over packed", &[None, Some("refs/remotes/")], false);
    }

    #[test]
    fn 创建与删除分支() {
        let (_d, r) = repo();
        create(&r, "feature", None, false).unwrap();
        assert!(git(&r, &["branch"]).contains("feature"));
        delete_local(&r, "feature").unwrap();
        assert!(!git(&r, &["branch"]).contains("feature"));
    }

    #[test]
    fn 从指定起点创建分支() {
        let (_d, r) = repo();
        let head = git(&r, &["rev-parse", "HEAD"]).trim().to_string();
        std::fs::write(r.join("a.txt"), "2\n").unwrap();
        git(&r, &["commit", "-qam", "second"]);

        create(&r, "from-first", Some(&head), false).unwrap();
        let at = git(&r, &["rev-parse", "from-first"]).trim().to_string();
        assert_eq!(at, head, "新分支应指向指定的起点而不是 HEAD");
    }

    fn to_discard(path: &str, change: crate::status::ChangeType) -> DiscardFile {
        DiscardFile { path: path.into(), old_path: None, change, submodule: false }
    }

    /// 丢弃子模块 = 把它复位回父仓库记录的提交，而不是把目录扔进废纸篓。
    #[test]
    fn 丢弃子模块是复位而不是删目录() {
        use crate::status::ChangeType;
        let (_d, outer) = crate::test_repo::with_submodule();
        let before = crate::system::submodule_info(&outer, "mod").unwrap();
        assert_ne!(before.recorded, before.actual);

        discard(
            &outer,
            &[DiscardFile { path: "mod".into(), old_path: None, change: ChangeType::Modified, submodule: true }],
        )
        .unwrap();

        let after = crate::system::submodule_info(&outer, "mod").unwrap();
        assert_eq!(after.recorded, after.actual, "应复位到父仓库记录的那个提交");
        assert!(outer.join("mod").join(".git").exists(), "子模块目录不该被扔掉");
    }

    #[test]
    fn 丢弃已跟踪文件的改动() {
        use crate::status::ChangeType;
        let (_d, r) = repo();
        std::fs::write(r.join("a.txt"), "改坏了\n").unwrap();
        assert!(!git(&r, &["status", "--porcelain"]).is_empty());

        discard(&r, &[to_discard("a.txt", ChangeType::Modified)]).unwrap();
        assert!(git(&r, &["status", "--porcelain"]).is_empty(), "改动应已丢弃");
        assert_eq!(std::fs::read_to_string(r.join("a.txt")).unwrap(), "1\n");
    }

    #[test]
    fn 丢弃未跟踪文件后工作区干净() {
        use crate::status::ChangeType;
        let (_d, r) = repo();
        std::fs::write(r.join("new.txt"), "x\n").unwrap();
        discard(&r, &[to_discard("new.txt", ChangeType::Added)]).unwrap();
        assert!(!r.join("new.txt").exists(), "应从工作区消失（进了废纸篓）");
        assert!(
            git(&r, &["status", "--porcelain"]).is_empty(),
            "工作区应当干净，实际: {:?}",
            git(&r, &["status", "--porcelain"])
        );
    }

    #[test]
    fn 丢弃删除的文件会把它找回来() {
        use crate::status::ChangeType;
        let (_d, r) = repo();
        std::fs::remove_file(r.join("a.txt")).unwrap();
        discard(&r, &[to_discard("a.txt", ChangeType::Deleted)]).unwrap();
        assert!(r.join("a.txt").exists(), "删掉的文件应被找回来");
        assert!(git(&r, &["status", "--porcelain"]).is_empty());
    }

    /// 重命名在 index 里是两条记录（旧路径删除 + 新路径新增）。
    /// 只处理新路径的话，旧名字回不来，git 仍然认为文件被删了。
    #[test]
    fn 丢弃重命名会把旧名字还回来() {
        use crate::status::ChangeType;
        let (_d, r) = repo();
        std::fs::write(r.join("长文件.txt"), "内容要够长才会被认成重命名\n".repeat(10)).unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "加个文件"]);
        git(&r, &["mv", "长文件.txt", "新名字.txt"]);

        discard(
            &r,
            &[DiscardFile {
                path: "新名字.txt".into(),
                old_path: Some("长文件.txt".into()),
                change: ChangeType::Renamed,
                submodule: false,
            }],
        )
        .unwrap();
        assert!(r.join("长文件.txt").exists(), "旧名字应该回来了");
        assert!(!r.join("新名字.txt").exists(), "新名字应该没了");
        assert!(git(&r, &["status", "--porcelain"]).is_empty(), "实际: {}", git(&r, &["status", "--porcelain"]));
    }

    /// 冲突中的文件也要能丢弃：我们这边有版本就回到那一版，没有（对面新增的、
    /// 或我们删掉的）就保持不在。GitLens 专门为这种情况写了测试，值得跟一条。
    #[test]
    fn 丢弃冲突文件回到_head_那一版() {
        use crate::status::ChangeType;
        let (_d, r) = repo();
        git(&r, &["switch", "-qc", "他们"]);
        std::fs::write(r.join("a.txt"), "他们改的\n").unwrap();
        git(&r, &["commit", "-qam", "他们"]);
        // 回到原来那条分支——repo() 没指定 -b，分支名跟着用户的 init.defaultBranch 走
        git(&r, &["switch", "-q", "-"]);
        std::fs::write(r.join("a.txt"), "我们改的\n").unwrap();
        git(&r, &["commit", "-qam", "我们"]);
        git(&r, &["merge", "他们"]);
        assert!(std::fs::read_to_string(r.join("a.txt")).unwrap().contains("<<<<"));

        discard(&r, &[to_discard("a.txt", ChangeType::Conflicted)]).unwrap();
        assert_eq!(std::fs::read_to_string(r.join("a.txt")).unwrap(), "我们改的\n", "应回到当前分支那一版");
        assert!(crate::ops::conflicted_files(&r).is_empty(), "丢弃之后不该还是冲突状态");
    }

    #[test]
    fn 拒绝_ext_协议() {
        let d = tempfile::tempdir().unwrap();
        let err = clone("ext::sh -c whoami", &d.path().join("x"), None).unwrap_err();
        assert_eq!(err, "The \"ext\" transport is not supported for cloning in GitCub.");
    }

    #[test]
    fn 拒绝克隆到敏感目录() {
        let home = dirs_home().unwrap();
        for p in [home.join(".ssh"), home.join(".config").join("git"), home.clone()] {
            assert!(is_path_sensitive(&p), "{} 应被判为敏感", p.display());
        }
        assert!(!is_path_sensitive(&home.join("Projects").join("x")));
    }

    #[test]
    fn 克隆本地仓库() {
        let (_d, src) = repo();
        let dst = tempfile::tempdir().unwrap();
        let target = dst.path().join("cloned");
        clone(src.to_str().unwrap(), &target, None).unwrap();
        assert!(target.join(".git").is_dir());
        assert_eq!(std::fs::read_to_string(target.join("a.txt")).unwrap(), "1\n");
    }
}
