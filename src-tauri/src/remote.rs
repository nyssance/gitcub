//! 仓库的 origin 远端：从 URL 里拆出 host / owner / 名字。
//!
//! 左栏靠它分组：host 决定归到 GitHub 还是 GitLab，owner 用来判断这个仓库
//! 是不是你自己的（跟账号的 login 比）。

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    /// 主机名，如 github.com / gitlab.com / git.example.com。经 `account_remote` 归到已知实例后
    /// 是实例标识 `host[:port][/子路径]`，owner 相对实例（不含子路径）
    pub host: String,
    /// 命名空间。GitLab 的子组会是多段，如 group/subgroup
    pub owner: String,
    /// 仓库名，不带 .git
    pub name: String,
}

/// 读仓库的 `remote.origin.url` 并拆开。没有 origin、或 URL 不认识就返回 None。
pub fn origin(repo: &Path) -> Result<Option<Remote>, String> {
    Ok(crate::remote_ops::get_url(repo, "origin")?.and_then(|url| parse(&url)))
}

/// 支持 git 常见的几种写法：
///   git@host:owner/name.git
///   ssh://git@host[:port]/owner/name.git
///   https://host/owner/name.git
///   /本地/路径 —— 没有 host，返回 None
pub fn parse(url: &str) -> Option<Remote> {
    let url = url.trim();
    if url.chars().any(char::is_control) {
        return None;
    }
    if let Some(rest) = url.strip_prefix("git:").filter(|rest| !rest.starts_with("//")) {
        let (host, path) = rest.split_once('/')?;
        return split_path(host, path);
    }
    if url.contains("://") {
        let parsed = reqwest::Url::parse(url).ok()?;
        if !matches!(parsed.scheme(), "https" | "http" | "ssh" | "git") {
            return None;
        }
        let mut host = parsed.host_str()?.to_string();
        // SSH 端口不等于 Web/API 端口；HTTPS 自建实例的非标准端口则必须保留。
        if matches!(parsed.scheme(), "https" | "http")
            && let Some(port) = parsed.port()
        {
            host = format!("{host}:{port}");
        }
        return split_path(&host, parsed.path());
    }
    // scp 的冒号后面是路径，数字开头的命名空间也合法。
    let (authority, path) = if let Some((authority, path)) = url.split_once("]:") {
        (format!("{authority}]"), path)
    } else {
        let (authority, path) = url.split_once(':')?;
        if authority.len() == 1 && authority.as_bytes()[0].is_ascii_alphabetic() {
            return None;
        }
        (authority.to_string(), path)
    };
    if authority.contains('/') || authority.contains('\\') {
        return None;
    }
    let parsed = reqwest::Url::parse(&format!("ssh://{authority}/")).ok()?;
    split_path(parsed.host_str()?, path)
}

/// 实例标识是 `hostname[:port][/子路径]`：GitLab 可以部署在 `https://host/gitlab` 这样的子路径下，
/// 接口在 `<实例>/api/v4`，网页在 `<实例>/<owner>/<name>`。拆成 authority 和不带首尾斜杠的子路径。
pub fn split_instance(instance: &str) -> (&str, &str) {
    match instance.split_once('/') {
        Some((authority, path)) => (authority, path.trim_matches('/')),
        None => (instance, ""),
    }
}

/// 远端是否落在这个实例下：authority 相同（不分大小写），owner 按整段以子路径开头。
/// 落在下面就返回改写后的远端：host 换成实例标识，owner 去掉子路径。
pub fn within(remote: &Remote, instance: &str) -> Option<Remote> {
    let (authority, path) = split_instance(instance);
    if !authority.eq_ignore_ascii_case(&remote.host) {
        return None;
    }
    let owner = if path.is_empty() {
        remote.owner.as_str()
    } else {
        let head = remote.owner.get(..path.len())?;
        if !head.eq_ignore_ascii_case(path) {
            return None;
        }
        remote.owner[path.len()..].strip_prefix('/').filter(|rest| !rest.is_empty())?
    };
    Some(Remote { host: instance.to_string(), owner: owner.to_string(), name: remote.name.clone() })
}

/// URL 本身能确定的实例：包含这个远端的已知实例里子路径最长的那个。不按 hostname 猜。
pub fn instance_of(remote: &Remote, known: &[String]) -> Option<Remote> {
    known
        .iter()
        .filter_map(|instance| within(remote, instance).map(|resolved| (split_instance(instance).1.len(), resolved)))
        .max_by_key(|(length, _)| *length)
        .map(|(_, resolved)| resolved)
}

/// 远端 → 账号实例，与前端 `src/lib/account-host.ts` 的 `accountRemoteFor` 同一规则：
/// 先按 URL 取最长匹配的实例；匹配不上时（SSH 远端既不带 Web 端口也不带子路径），
/// 按 Desktop `matchGitHubRepository` 的 hostname 匹配，唯一一个同 hostname 的已知实例就是它，
/// 有多个候选时不猜，保持原样。
pub fn account_remote(remote: &Remote, known: &[String]) -> Remote {
    instance_of(remote, known).unwrap_or_else(|| Remote { host: account_host(&remote.host, known), ..remote.clone() })
}

/// 选 Git 传输凭据用的实例：只认 URL 本身能确定的实例，否则就是远端自己的 host。
/// 不走 hostname 猜测，子路径实例的令牌不会交给同一主机上的其他实例。
pub fn credential_instance(remote: &Remote, known: &[String]) -> String {
    instance_of(remote, known).map_or_else(|| remote.host.clone(), |resolved| resolved.host)
}

fn account_host(host: &str, known: &[String]) -> String {
    let has_port = |h: &str| match h.strip_prefix('[') {
        Some(rest) => rest.split_once(']').is_some_and(|(_, tail)| tail.starts_with(':')),
        None => h.contains(':'),
    };
    if has_port(host) || known.iter().any(|k| k == host) {
        return host.to_string();
    }
    let hostname = |h: &str| reqwest::Url::parse(&format!("https://{h}/")).ok()?.host_str().map(str::to_lowercase);
    let wanted = hostname(host);
    let mut candidates = known.iter().filter(|k| wanted.is_some() && hostname(k) == wanted);
    match (candidates.next(), candidates.next()) {
        (Some(only), None) => only.clone(),
        _ => host.to_string(),
    }
}

fn split_path(host: &str, path: &str) -> Option<Remote> {
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.rsplit_once('/')?;
    if host.is_empty() || owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(Remote { host: host.to_lowercase(), owner: owner.to_string(), name: name.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_failure_is_not_a_repository_without_origin() {
        let directory = tempfile::tempdir().unwrap();
        assert!(origin(&directory.path().join("missing")).is_err());
    }

    fn r(host: &str, owner: &str, name: &str) -> Option<Remote> {
        Some(Remote { host: host.into(), owner: owner.into(), name: name.into() })
    }

    #[test]
    fn scp_风格() {
        assert_eq!(parse("git@github.com:nyssance/gitcub.git"), r("github.com", "nyssance", "gitcub"));
    }

    #[test]
    fn https_带不带_git_后缀都认() {
        assert_eq!(parse("https://github.com/nyssance/gitcub.git"), r("github.com", "nyssance", "gitcub"));
        assert_eq!(parse("https://github.com/nyssance/gitcub"), r("github.com", "nyssance", "gitcub"));
    }

    #[test]
    fn ssh_带端口() {
        assert_eq!(parse("ssh://git@git.example.com:2222/team/app.git"), r("git.example.com", "team", "app"));
    }

    #[test]
    fn gitlab_子组的_owner_是多段() {
        assert_eq!(parse("https://gitlab.com/group/subgroup/app.git"), r("gitlab.com", "group/subgroup", "app"));
    }

    #[test]
    fn 本地路径没有远端归属() {
        assert_eq!(parse("/Users/ny/Projects/gitcub"), None);
        assert_eq!(parse("../sibling"), None);
        assert_eq!(parse("C:/Users/me/repo"), None);
        assert_eq!(parse("file://server/group/repo.git"), None);
    }

    #[test]
    fn 自建实例保留_web端口但不把ssh端口当api端口() {
        assert_eq!(parse("https://git.example:8443/group/sub/repo.git"), r("git.example:8443", "group/sub", "repo"));
        assert_eq!(parse("ssh://git@git.example:2222/group/sub/repo.git"), r("git.example", "group/sub", "repo"));
    }

    fn known(hosts: &[&str]) -> Vec<String> {
        hosts.iter().map(|h| h.to_string()).collect()
    }

    fn account(url: &str, hosts: &[&str]) -> Option<Remote> {
        Some(account_remote(&parse(url)?, &known(hosts)))
    }

    #[test]
    fn ssh_远端挂到唯一同名的带端口实例() {
        let host = |h: &str, hosts: &[&str]| account_host(h, &known(hosts));
        assert_eq!(host("git.example", &["github.com", "git.example:8443"]), "git.example:8443");
        assert_eq!(host("git.example", &["git.example", "git.example:8443"]), "git.example");
        assert_eq!(host("git.example", &["git.example:8443", "git.example:9443"]), "git.example");
        assert_eq!(host("git.example:8443", &["git.example:9443"]), "git.example:8443");
        assert_eq!(host("[2001:db8::1]", &["[2001:db8::1]:8443"]), "[2001:db8::1]:8443");
        assert_eq!(host("other.example", &["git.example:8443"]), "other.example");
    }

    #[test]
    fn 子路径实例的_https_远端去掉子路径() {
        let hosts = ["github.com", "git.example/gitlab"];
        let expected = r("git.example/gitlab", "group/sub", "project");
        assert_eq!(account("https://git.example/gitlab/group/sub/project.git", &hosts), expected);
        assert_eq!(account("https://git.example/gitlab/group/sub/project", &hosts), expected);
        assert_eq!(account("https://Git.Example/GitLab/group/sub/project.git/", &hosts), expected);
        assert_eq!(account("https://user@git.example/gitlab/group/sub/project.git", &hosts), expected);
        assert_eq!(account("http://git.example/gitlab/group/sub/project.git", &hosts), expected);
        // 子路径按整段匹配；只剩一段时不是这个实例下的项目
        assert_eq!(
            account("https://git.example/gitlabx/group/project.git", &["git.example/gitlab", "git.example/other"]),
            r("git.example", "gitlabx/group", "project")
        );
        assert_eq!(within(&parse("https://git.example/gitlab/project.git").unwrap(), "git.example/gitlab"), None);
        // GitHub 不受影响
        assert_eq!(account("https://github.com/nyssance/gitcub.git", &hosts), r("github.com", "nyssance", "gitcub"));
    }

    #[test]
    fn 子路径实例带端口时端口也要一致() {
        let hosts = ["git.example:8443/gitlab"];
        assert_eq!(
            account("https://git.example:8443/gitlab/group/sub/project.git", &hosts),
            r("git.example:8443/gitlab", "group/sub", "project")
        );
        assert_eq!(
            account("https://git.example:9443/gitlab/group/project.git", &hosts),
            r("git.example:9443", "gitlab/group", "project")
        );
        assert_eq!(
            account("https://[2001:db8::1]:8443/gitlab/group/project.git", &["[2001:db8::1]:8443/gitlab"]),
            r("[2001:db8::1]:8443/gitlab", "group", "project")
        );
    }

    #[test]
    fn 同主机多个子路径实例取最长匹配() {
        let hosts = ["git.example", "git.example/gitlab", "git.example/gitlab/next"];
        assert_eq!(
            account("https://git.example/gitlab/group/project.git", &hosts),
            r("git.example/gitlab", "group", "project")
        );
        assert_eq!(
            account("https://git.example/gitlab/next/group/project.git", &hosts),
            r("git.example/gitlab/next", "group", "project")
        );
        assert_eq!(account("https://git.example/group/project.git", &hosts), r("git.example", "group", "project"));
    }

    #[test]
    fn ssh_远端按唯一_hostname_挂到子路径实例() {
        assert_eq!(
            account("git@git.example:group/sub/project.git", &["github.com", "git.example/gitlab"]),
            r("git.example/gitlab", "group/sub", "project")
        );
        assert_eq!(
            account("ssh://git@Git.Example:2222/group/project.git", &["git.example:8443/gitlab"]),
            r("git.example:8443/gitlab", "group", "project")
        );
        // 同一 hostname 有多个实例：SSH 不猜
        assert_eq!(
            account("git@git.example:group/project.git", &["git.example/a", "git.example/b"]),
            r("git.example", "group", "project")
        );
        // 根实例与 SSH 远端的 host 完全相同，就是根实例
        assert_eq!(
            account("git@git.example:group/project.git", &["git.example", "git.example/gitlab"]),
            r("git.example", "group", "project")
        );
    }

    #[test]
    fn 选凭据只认_url_能确定的实例() {
        let hosts = known(&["git.example", "git.example/gitlab"]);
        let instance = |url: &str, hosts: &[String]| credential_instance(&parse(url).unwrap(), hosts);
        assert_eq!(instance("https://git.example/gitlab/group/project.git", &hosts), "git.example/gitlab");
        assert_eq!(instance("https://git.example/group/project.git", &hosts), "git.example");
        assert_eq!(instance("https://git.example/gitlabx/group/project.git", &hosts), "git.example");
        let only_subpath = known(&["git.example/gitlab"]);
        // 不按 hostname 猜：URL 不在子路径下就不用子路径实例的令牌
        assert_eq!(instance("git@git.example:group/project.git", &only_subpath), "git.example");
        assert_eq!(instance("https://git.example/group/project.git", &only_subpath), "git.example");
        assert_eq!(instance("https://other.example/gitlab/group/project.git", &only_subpath), "other.example");
        assert_eq!(instance("https://git.example:8443/gitlab/group/project.git", &only_subpath), "git.example:8443");
    }

    #[test]
    fn 实例标识拆出_authority_与子路径() {
        assert_eq!(split_instance("git.example"), ("git.example", ""));
        assert_eq!(split_instance("git.example:8443/gitlab/"), ("git.example:8443", "gitlab"));
        assert_eq!(split_instance("[2001:db8::1]:8443/a/b"), ("[2001:db8::1]:8443", "a/b"));
    }

    #[test]
    fn 数字命名空间与ipv6不被误解析() {
        assert_eq!(parse("git@git.example:123team/repo.git"), r("git.example", "123team", "repo"));
        assert_eq!(parse("git@[2001:db8::1]:group/repo.git"), r("[2001:db8::1]", "group", "repo"));
        assert_eq!(parse("https://[2001:db8::1]:8443/group/repo.git"), r("[2001:db8::1]:8443", "group", "repo"));
        assert_eq!(parse("https://git.example/owner\n/repo"), None);
    }
}
