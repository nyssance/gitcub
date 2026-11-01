//! 账号与仓库元信息：按 host 问「我是谁」和「这个仓库是什么」。
//!
//! 左栏靠它做两件事：
//!   1. 判断仓库是不是「我的」—— origin 的 owner 命中你的命名空间
//!      （登录名 + 你所属的组织 / 群组）。只比登录名不够：自己的项目
//!      常常挂在组织下（owner=ALwith-ai 而 login=nyssance）。
//!   2. 选图标 —— 私有仓是锁，fork 是分叉（规则照原版 iconForRepository）。
//!
//! host 是按仓库的 origin 现算的，不写死 github.com / gitlab.com：
//! 自建 GitLab 和 GitHub Enterprise 一样要能用。判不出来一律当第三方，
//! 用户还能右键手动改，手动结果优先。

use crate::credentials::{self, Source};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

const USER_AGENT: &str = concat!("GitCub/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Github,
    Gitlab,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub kind: Option<Kind>,
    pub login: Option<String>,
    /// 命名空间：登录名 + 组织 / 顶层群组
    pub owners: Vec<String>,
    /// 凭据是从哪儿找到的，界面上要告诉用户「你已经登录过了」
    pub source: Option<Source>,
    /// 用户显式登出过这个实例
    pub ignored: bool,
    /// 最近一次验证失败的原因。失败时其余字段沿用最后一次成功的结果，
    /// 不能把「连不上」「令牌失效」显示成未登录，也不能让仓库归属跟着跳变。
    #[serde(default)]
    pub error: Option<String>,
    /// 服务器以 401 拒绝了凭据（令牌过期、被吊销），需要重新登录。
    #[serde(default)]
    pub unauthorized: bool,
    /// 显示名与头像，来自同一次 `/user` 响应（Desktop accounts.tsx 的账号行要显示它们），不另发请求
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

/// `/user` 响应里的显示名与头像；两家都叫 `name` / `avatar_url`，空串当作没有
fn profile(me: &serde_json::Value) -> (Option<String>, Option<String>) {
    let text = |key: &str| me.get(key).and_then(|v| v.as_str()).filter(|v| !v.is_empty()).map(str::to_string);
    (text("name"), text("avatar_url"))
}

/// 平台以 401 拒绝凭据。分不清平台的自建实例会合并 GitLab 与 GitHub Enterprise 两条错误，任一侧是 401 都算。
pub fn is_unauthorized(error: &str) -> bool {
    error.contains("HTTP 401")
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMeta {
    pub private: bool,
    pub fork: bool,
}

/// A missing credential is signed out; a failed request is not.
/// `refresh` is the user's explicit retry: a failure cached moments ago must not answer it.
pub async fn one(host: &str, refresh: bool) -> Result<Account, String> {
    if crate::settings::is_ignored(host) {
        return Ok(Account { ignored: true, ..Account::default() });
    }
    crate::oauth::refresh(host).await?;
    let Some(found) = credentials::find_async(host).await else {
        return Ok(Account::default());
    };
    identify(host, &found, refresh).await
}

// A single credential snapshot identifies the provider and performs the operation.
// Re-discovery after /user could otherwise switch accounts halfway through a request.
async fn authenticated(host: &str) -> Result<(Account, String), String> {
    authenticated_with(host, false).await
}

async fn authenticated_with(host: &str, refresh: bool) -> Result<(Account, String), String> {
    crate::oauth::refresh(host).await?;
    let found = credentials::find_async(host).await.ok_or_else(|| format!("{host} 还没登录"))?;
    let account = identify(host, &found, refresh).await.map_err(|error| format!("{host} 账号验证失败：{error}"))?;
    if crate::settings::is_ignored(host) {
        return Err(format!("{host} 已登出"));
    }
    Ok((account, found.token))
}

async fn identify(host: &str, found: &credentials::Found, refresh: bool) -> Result<Account, String> {
    cached_identity(host, &found.token, refresh, identify_uncached(host, found)).await.map(|mut account| {
        account.source = Some(found.source);
        account
    })
}

struct IdentityResult {
    token: String,
    expires: Instant,
    result: Result<Account, String>,
}
type IdentitySlot = Arc<tauri::async_runtime::Mutex<Option<IdentityResult>>>;
static IDENTITIES: LazyLock<Mutex<HashMap<String, IdentitySlot>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

// All account consumers share one in-flight identity request per host. Short
// failure caching stops a failed /user from being retried by every UI consumer;
// an explicit refresh retries it right away so a recovered network shows at once.
async fn cached_identity(
    host: &str, token: &str, refresh: bool, fetch: impl std::future::Future<Output = Result<Account, String>>,
) -> Result<Account, String> {
    let slot = IDENTITIES.lock().map_err(|_| "Account cache unavailable")?.entry(host.into()).or_default().clone();
    let mut cached = slot.lock().await;
    if let Some(entry) = cached.as_ref()
        && entry.token == token
        && entry.expires > Instant::now()
        && !(refresh && entry.result.is_err())
    {
        return entry.result.clone();
    }
    let result = fetch.await;
    let ttl = if result.is_ok() { 300 } else { 60 };
    *cached = Some(IdentityResult {
        token: token.into(),
        expires: Instant::now() + Duration::from_secs(ttl),
        result: result.clone(),
    });
    result
}

async fn identify_uncached(host: &str, found: &credentials::Found) -> Result<Account, String> {
    if host == "github.com" {
        return github(host, &found.token, found.source, crate::host_url::DOT_COM_API_ENDPOINT).await;
    }
    identify_at(host, found, &format!("https://{host}/api/v4"), &format!("https://{host}/api/v3")).await
}

/// 自建实例先按 GitLab 问，再按 GitHub Enterprise 问；只有两边都失败、又分不清是哪家时才合并两条错误。
/// 已经知道是哪家（登录时选过平台、子路径实例、GitLab 自己答了 401）就只报那一家的原因。
async fn identify_at(
    host: &str, found: &credentials::Found, gitlab_base: &str, github_base: &str,
) -> Result<Account, String> {
    match found.kind {
        Some(Kind::Github) => {
            return github(host, &found.token, found.source, github_base)
                .await
                .map_err(|error| format!("GitHub Enterprise: {error}"));
        }
        Some(Kind::Gitlab) => {
            return gitlab(gitlab_base, &found.token, found.source).await.map_err(|error| format!("GitLab: {error}"));
        }
        None => {}
    }
    match gitlab(gitlab_base, &found.token, found.source).await {
        Ok(account) => Ok(account),
        // GitHub Enterprise Server 不支持子路径部署，子路径实例只可能是 GitLab。
        Err(gitlab_error) if !crate::remote::split_instance(host).1.is_empty() => {
            Err(format!("GitLab: {gitlab_error}"))
        }
        // 连不上这台主机时 GitHub Enterprise 接口同样连不上：不再等第二个超时，错误也只报一次。
        Err(gitlab_error) if is_transport_error(&gitlab_error) => Err(gitlab_error),
        // /api/v4/user 以 GitLab 的响应体答了 401：这台就是 GitLab，令牌被拒；
        // GitHub Enterprise 探测只会再添一条 404，把「重新登录」的提示搅浑。
        Err(gitlab_error) if is_gitlab_unauthorized(&gitlab_error) => Err(format!("GitLab: {gitlab_error}")),
        Err(gitlab_error) => github(host, &found.token, found.source, github_base)
            .await
            .map_err(|github_error| format!("GitLab: {gitlab_error}；GitHub Enterprise: {github_error}")),
    }
}

/// 请求根本没到服务器（断网、DNS、拒绝连接、TLS）；见 host_api::read_response。
fn is_transport_error(error: &str) -> bool {
    error.starts_with("请求失败")
}

/// GitLab 拒绝令牌的响应体是 `{"message":"401 Unauthorized"}`，过期或吊销的 OAuth 令牌则是
/// `{"error":"invalid_token",…}`（GitHub 两种情况都是 "Bad credentials"）；经 host_api 变成
/// 「HTTP 401 Unauthorized：401 Unauthorized」或「HTTP 401 Unauthorized：invalid_token」。
fn is_gitlab_unauthorized(error: &str) -> bool {
    error.starts_with("HTTP 401") && (error.ends_with("：401 Unauthorized") || error.ends_with("：invalid_token"))
}

/// 读不到组织 / 群组列表时账号不能算验证成功：owners 只剩登录名，会把组织下的仓库都判成第三方，
/// 并覆盖上一次完整的结果。令牌确实没有这个权限（403 / 404，非限流）时才照旧只用登录名。
fn namespaces_unavailable(error: &str) -> Option<String> {
    let scope_denied = (error.starts_with("HTTP 403") || error.starts_with("HTTP 404"))
        && !error.to_lowercase().contains("rate limit");
    (!scope_denied).then(|| format!("读取组织列表失败：{error}"))
}

async fn github(host: &str, token: &str, source: Source, base: &str) -> Result<Account, String> {
    let url = crate::host_url::absolute_url(base, "user")?;
    let me = crate::host_api::get(&url, token).await?;
    let login = me
        .get("login")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{host} 的账号响应缺少 login"))?
        .to_string();
    let mut owners = vec![login.clone()];
    match crate::host_api::list(&format!("{base}/user/orgs?per_page=100"), token, None).await {
        Ok(list) => owners.extend(list.iter().filter_map(|o| o.get("login")?.as_str()).map(str::to_string)),
        Err(error) => {
            if let Some(error) = namespaces_unavailable(&error) {
                return Err(error);
            }
        }
    }
    let (name, avatar_url) = profile(&me);
    Ok(Account {
        kind: Some(Kind::Github),
        login: Some(login),
        owners,
        source: Some(source),
        name,
        avatar_url,
        ..Account::default()
    })
}

async fn gitlab(base: &str, token: &str, source: Source) -> Result<Account, String> {
    let me = crate::host_api::get(&format!("{base}/user"), token).await?;
    let login = me
        .get("username")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or("GitLab 的账号响应缺少 username")?
        .to_string();
    let mut owners = vec![login.clone()];
    match crate::host_api::list(&format!("{base}/groups?min_access_level=10&per_page=100"), token, None).await {
        Ok(list) => owners.extend(list.iter().filter_map(|g| g.get("full_path")?.as_str()).map(str::to_string)),
        Err(error) => {
            if let Some(error) = namespaces_unavailable(&error) {
                return Err(error);
            }
        }
    }
    let (name, avatar_url) = profile(&me);
    Ok(Account {
        kind: Some(Kind::Gitlab),
        login: Some(login),
        owners,
        source: Some(source),
        name,
        avatar_url,
        ..Account::default()
    })
}

/// 远端仓库。你自己的仓库列表和 star 列表都用它。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepo {
    pub host: String,
    pub owner: String,
    pub name: String,
    pub description: Option<String>,
    pub language: Option<String>,
    pub stars: u32,
    pub private: bool,
    pub fork: bool,
    /// 克隆地址（HTTPS）
    pub url: String,
}

/// 你在这个实例上的仓库（含私有、组织的）。`refresh` 是界面上的刷新按钮。
pub async fn user_repos(host: &str, refresh: bool) -> Result<Vec<RemoteRepo>, String> {
    list(host, Endpoint::Mine, refresh).await
}

/// 你 star 过的仓库。
pub async fn starred(host: &str, refresh: bool) -> Result<Vec<RemoteRepo>, String> {
    list(host, Endpoint::Starred, refresh).await
}

#[derive(Clone, Copy)]
enum Endpoint {
    Mine,
    Starred,
}

async fn list(host: &str, which: Endpoint, refresh: bool) -> Result<Vec<RemoteRepo>, String> {
    let (account, token) = authenticated_with(host, refresh).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;

    let url = match (kind, which) {
        (Kind::Github, Endpoint::Mine) => format!(
            "{}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
            github_base(host)
        ),
        (Kind::Github, Endpoint::Starred) => {
            format!("{}/user/starred?per_page=100", github_base(host))
        }
        // GitLab 的「我的」= 我是成员的项目；star 列表是同一个接口换个参数
        (Kind::Gitlab, Endpoint::Mine) => {
            format!("https://{host}/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at")
        }
        (Kind::Gitlab, Endpoint::Starred) => {
            format!("https://{host}/api/v4/projects?starred=true&per_page=100")
        }
    };

    let items = crate::host_api::list(&url, &token, None).await?;

    items.iter().map(|item| remote_repo(host, kind, item)).collect()
}

fn remote_repo(host: &str, kind: Kind, item: &serde_json::Value) -> Result<RemoteRepo, String> {
    let (path_field, url_field, stars_field) = match kind {
        Kind::Github => ("full_name", "clone_url", "stargazers_count"),
        Kind::Gitlab => ("path_with_namespace", "http_url_to_repo", "star_count"),
    };
    let invalid = || "API 仓库缺少有效路径或克隆地址，未返回不完整列表".to_string();
    let path = item.get(path_field).and_then(serde_json::Value::as_str).ok_or_else(invalid)?;
    let (owner, name) =
        path.rsplit_once('/').filter(|(owner, name)| !owner.is_empty() && !name.is_empty()).ok_or_else(invalid)?;
    let url =
        item.get(url_field).and_then(serde_json::Value::as_str).filter(|url| !url.is_empty()).ok_or_else(invalid)?;
    Ok(RemoteRepo {
        host: host.to_string(),
        owner: owner.to_string(),
        name: name.to_string(),
        // Optional metadata may be absent as well as null. Neither hides a repository.
        description: item.get("description").and_then(serde_json::Value::as_str).map(str::to_string),
        language: match kind {
            Kind::Github => item.get("language").and_then(serde_json::Value::as_str).map(str::to_string),
            Kind::Gitlab => None,
        },
        stars: item.get(stars_field).and_then(serde_json::Value::as_u64).unwrap_or(0).min(u64::from(u32::MAX)) as u32,
        private: match kind {
            Kind::Github => item.get("private").and_then(serde_json::Value::as_bool).unwrap_or(true),
            Kind::Gitlab => item.get("visibility").and_then(serde_json::Value::as_str) != Some("public"),
        },
        fork: match kind {
            Kind::Github => item.get("fork").and_then(serde_json::Value::as_bool).unwrap_or(false),
            Kind::Gitlab => item.get("forked_from_project").is_some_and(|value| !value.is_null()),
        },
        url: url.to_string(),
    })
}

fn github_base(host: &str) -> String {
    if host == "github.com" {
        crate::host_url::DOT_COM_API_ENDPOINT.to_string()
    } else {
        format!("https://{host}/api/v3")
    }
}

/// Pull Request / Merge Request。两家字段名不同，这里统一成一套。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    #[serde(default)]
    pub created_at: String,
    /// 源分支最新提交。查检查项要用
    #[serde(default)]
    pub head_sha: String,
    pub title: String,
    pub author: String,
    /// 源分支
    pub head: String,
    /// 目标分支
    pub base: String,
    pub draft: bool,
    pub url: String,
    /// CI 状态：success / failure / pending，取不到就是 None
    pub checks: Option<String>,
}

/// 某个仓库的开放 PR / MR 列表。
pub async fn pull_requests(host: &str, owner: &str, name: &str) -> Result<Vec<PullRequest>, String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;

    match kind {
        Kind::Github => {
            let url = format!("{}/repos/{owner}/{name}/pulls?state=open&per_page=50", github_base(host));
            let items = crate::host_api::list(&url, &token, None).await?;
            // GitHub 的 CI 状态不在列表里，每条要再查询 Check Runs。
            // 串行的话 50 条 PR 就是 50 个来回，实测等到超时都出不来——并发发出去。
            let mut all_checks = Vec::with_capacity(items.len());
            // 分页后可能有数百条；限制同时进行的 CI 请求，避免一次耗尽连接和 API 配额。
            for chunk in items.chunks(8) {
                let checks: Vec<_> = chunk
                    .iter()
                    .map(|it| {
                        let sha =
                            it.get("head").and_then(|h| h.get("sha")).and_then(|s| s.as_str()).map(str::to_string);
                        let base = github_base(host);
                        let (owner, name, token) = (owner.to_string(), name.to_string(), token.clone());
                        tauri::async_runtime::spawn(async move {
                            let sha = sha.ok_or("PR 缺少 head SHA")?;
                            github_checks(&base, &owner, &name, &sha, &token).await
                        })
                    })
                    .collect();
                for task in checks {
                    all_checks.push(task.await.map_err(|e| e.to_string())??);
                }
            }
            let mut checks = all_checks.into_iter();

            let mut out = Vec::new();
            for it in &items {
                let checks = checks.next().flatten();
                let Some(number) = it.get("number").and_then(|n| n.as_u64()) else {
                    continue;
                };
                out.push(PullRequest {
                    number,
                    created_at: field_str(it, &["created_at"]),
                    head_sha: field_str(it, &["head", "sha"]),
                    title: it.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                    author: it
                        .get("user")
                        .and_then(|u| u.get("login"))
                        .and_then(|l| l.as_str())
                        .unwrap_or("")
                        .to_string(),
                    head: field_str(it, &["head", "ref"]),
                    base: field_str(it, &["base", "ref"]),
                    draft: it.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
                    url: it.get("html_url").and_then(|u| u.as_str()).unwrap_or("").to_string(),
                    checks,
                });
            }
            Ok(out)
        }
        Kind::Gitlab => {
            let path = urlencoding(&format!("{owner}/{name}"));
            let url = format!("https://{host}/api/v4/projects/{path}/merge_requests?state=opened&per_page=50");
            let mut items = crate::host_api::list(&url, &token, None).await?;
            hydrate_gitlab_mrs(host, &token, &mut items).await?;
            Ok(items
                .iter()
                .filter_map(|it| {
                    Some(PullRequest {
                        number: it.get("iid")?.as_u64()?,
                        created_at: field_str(it, &["created_at"]),
                        head_sha: it.get("sha").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                        title: it.get("title")?.as_str()?.to_string(),
                        author: field_str(it, &["author", "username"]),
                        head: it.get("source_branch")?.as_str()?.to_string(),
                        base: it.get("target_branch")?.as_str()?.to_string(),
                        draft: it.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
                        url: it.get("web_url")?.as_str()?.to_string(),
                        // 列表不保证提供流水线，使用已补取的 MR 详情
                        checks: it
                            .get("head_pipeline")
                            .and_then(|p| p.get("status"))
                            .and_then(|s| s.as_str())
                            .map(normalize_pipeline),
                    })
                })
                .collect())
        }
    }
}

/// 跟「我」有关的 PR。用搜索接口一次问完，而不是逐个仓库轮询——
/// 后者的请求数等于本地仓库数，而且只看得见你本地有的那些仓库。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvolvedKind {
    /// 等我评审
    ReviewRequested,
    /// 我开的
    Authored,
}

pub async fn involved_prs(host: &str, kind: InvolvedKind) -> Result<Vec<PullRequest>, String> {
    let (account, token) = authenticated(host).await?;
    let provider = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;

    if provider == Kind::Gitlab {
        let url = gitlab_involved_url(host, kind, account.login.as_deref().ok_or("缺少 GitLab 用户名")?);
        let mut items = crate::host_api::list(&url, &token, None).await?;
        if kind == InvolvedKind::Authored {
            hydrate_gitlab_mrs(host, &token, &mut items).await?;
        }
        return Ok(items.iter().filter_map(|it| gitlab_involved_mr(host, it)).collect());
    }

    let filter = match kind {
        InvolvedKind::ReviewRequested => "review-requested:@me",
        InvolvedKind::Authored => "author:@me",
    };
    let q = urlencoding(&format!("is:open is:pr {filter}"));
    let url = format!("{}/search/issues?q={q}&per_page=30", github_base(host));
    let items = crate::host_api::list(&url, &token, Some("items")).await?;
    let mut result: Vec<PullRequest> = items
        .iter()
        .filter_map(|it| {
            // 搜索结果里没有 head/base，要从 repository_url 反推仓库
            let repo_url = it.get("repository_url")?.as_str()?;
            let full = repo_url.rsplit("/repos/").next()?;
            Some(PullRequest {
                number: it.get("number")?.as_u64()?,
                created_at: field_str(it, &["created_at"]),
                head_sha: String::new(),
                title: it.get("title")?.as_str()?.to_string(),
                author: field_str(it, &["user", "login"]),
                head: full.to_string(),
                base: String::new(),
                draft: it.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
                url: it.get("html_url")?.as_str()?.to_string(),
                checks: None,
            })
        })
        .collect();
    if kind == InvolvedKind::Authored {
        for chunk in result.chunks_mut(8) {
            let tasks: Vec<_> = chunk
                .iter()
                .map(|pr| {
                    let (host, token, project, number) = (host.to_string(), token.clone(), pr.head.clone(), pr.number);
                    tauri::async_runtime::spawn(async move {
                        let (owner, name) = project.split_once('/').ok_or("无效项目路径")?;
                        let base = github_base(&host);
                        let detail =
                            crate::host_api::get(&format!("{base}/repos/{owner}/{name}/pulls/{number}"), &token)
                                .await?;
                        let sha = detail["head"]["sha"].as_str().ok_or("PR 缺少 head SHA")?.to_string();
                        let checks = github_checks(&base, owner, name, &sha, &token).await?;
                        Ok::<_, String>((sha, checks))
                    })
                })
                .collect();
            for (pr, task) in chunk.iter_mut().zip(tasks) {
                (pr.head_sha, pr.checks) = task.await.map_err(|e| e.to_string())??;
            }
        }
    }
    Ok(result)
}

async fn github_checks(base: &str, owner: &str, name: &str, sha: &str, token: &str) -> Result<Option<String>, String> {
    let url = format!("{base}/repos/{owner}/{name}/commits/{}", urlencoding(sha));
    let checks = crate::host_api::list(&format!("{url}/check-runs?per_page=100"), token, Some("check_runs")).await?;
    Ok(aggregate_checks(&checks))
}

fn aggregate_checks(checks: &[serde_json::Value]) -> Option<String> {
    let states: Vec<&str> = checks
        .iter()
        .map(|check| {
            if check["status"].as_str() != Some("completed") {
                "pending"
            } else {
                match check["conclusion"].as_str() {
                    Some("failure" | "timed_out" | "action_required" | "startup_failure") => "failure",
                    Some("success" | "neutral" | "skipped") => "success",
                    Some("cancelled" | "stale") => "cancelled",
                    _ => "pending",
                }
            }
        })
        .collect();
    ["failure", "pending", "cancelled", "success"].into_iter().find(|state| states.contains(state)).map(str::to_string)
}

async fn hydrate_gitlab_mrs(host: &str, token: &str, items: &mut [serde_json::Value]) -> Result<(), String> {
    for chunk in items.chunks_mut(8) {
        let mut tasks = Vec::new();
        for item in chunk.iter() {
            let project = item["project_id"].as_u64().ok_or("MR 缺少项目 ID")?;
            let iid = item["iid"].as_u64().ok_or("MR 缺少项目内编号")?;
            let url = format!("https://{host}/api/v4/projects/{project}/merge_requests/{iid}");
            let token = token.to_string();
            tasks.push(tauri::async_runtime::spawn(async move { crate::host_api::get(&url, &token).await }));
        }
        for (item, task) in chunk.iter_mut().zip(tasks) {
            *item = task.await.map_err(|e| e.to_string())??;
        }
    }
    Ok(())
}

fn gitlab_involved_url(host: &str, kind: InvolvedKind, login: &str) -> String {
    let filter = match kind {
        InvolvedKind::Authored => "scope=created_by_me".to_string(),
        // reviewer_username 在旧版自建实例也可用，不依赖新加的 reviews_for_me scope。
        InvolvedKind::ReviewRequested => format!("scope=all&reviewer_username={}", urlencoding(login)),
    };
    format!("https://{host}/api/v4/merge_requests?state=opened&per_page=100&{filter}")
}

fn gitlab_involved_mr(host: &str, it: &serde_json::Value) -> Option<PullRequest> {
    let url = it.get("web_url")?.as_str()?;
    let parsed = reqwest::Url::parse(url).ok()?;
    let project = parsed.path().split("/-/merge_requests/").next()?.trim_start_matches('/');
    // 子路径实例的 web_url 带着子路径，项目路径要去掉它。
    let subpath = crate::remote::split_instance(host).1;
    let project = if subpath.is_empty() { project } else { project.strip_prefix(subpath)?.strip_prefix('/')? };
    Some(PullRequest {
        number: it.get("iid")?.as_u64()?,
        created_at: field_str(it, &["created_at"]),
        head_sha: it.get("sha").and_then(|v| v.as_str()).unwrap_or("").into(),
        title: it.get("title")?.as_str()?.into(),
        author: field_str(it, &["author", "username"]),
        // Inbox 与 GitHub 搜索结果一样显示项目路径，而不是源分支。
        head: project.into(),
        base: it.get("target_branch").and_then(|v| v.as_str()).unwrap_or("").into(),
        draft: it.get("draft").and_then(|v| v.as_bool()).unwrap_or(false),
        url: url.into(),
        checks: it
            .get("head_pipeline")
            .or_else(|| it.get("pipeline"))
            .and_then(|v| v.get("status"))
            .and_then(|v| v.as_str())
            .map(normalize_pipeline),
    })
}

/// 补全用的 issue：写提交信息时打个 `#` 就能把号码带出来。
///
/// 这**不是**把 issue 列表搬回来（那条早就砍了：纯网页内容，点开只能跳浏览器）。
/// 这里只服务一件本地的事——你正在写这次提交的信息，想写对号码。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
}

pub async fn issues(host: &str, owner: &str, name: &str) -> Result<Vec<Issue>, String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;

    let url = match kind {
        Kind::Github => {
            format!("{}/repos/{owner}/{name}/issues?state=open&per_page=100", github_base(host))
        }
        Kind::Gitlab => {
            let path = urlencoding(&format!("{owner}/{name}"));
            format!("https://{host}/api/v4/projects/{path}/issues?state=opened&per_page=100")
        }
    };
    let items = crate::host_api::list(&url, &token, None).await?;

    Ok(items
        .iter()
        // GitHub 的 issues 接口把 PR 也混在里面，带 pull_request 字段的要滤掉
        .filter(|it| it.get("pull_request").is_none())
        .filter_map(|it| {
            let number_key = match kind {
                Kind::Github => "number",
                Kind::Gitlab => "iid",
            };
            Some(Issue { number: it.get(number_key)?.as_u64()?, title: it.get("title")?.as_str()?.to_string() })
        })
        .collect())
}

/// 提交信息里 `@` 补全和共同作者候选：Desktop `IAPIMentionableUser` 的字段
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MentionableUser {
    pub login: String,
    pub name: Option<String>,
    /// 写进 Co-authored-by 的地址；平台没给公开邮箱时是它的 noreply 地址
    pub email: String,
    #[serde(rename = "avatarURL")]
    pub avatar_url: String,
}

/// Desktop `API.fetchMentionables`：GitHub 走 mentionables 接口；GitLab 对应的是项目里能被 @ 的用户
pub async fn mentionables(host: &str, owner: &str, name: &str) -> Result<Vec<MentionableUser>, String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;
    let items = match kind {
        Kind::Github => {
            let url =
                format!("{}/repos/{}/{}/mentionables/users", github_base(host), urlencoding(owner), urlencoding(name));
            crate::host_api::list_accepting(&url, &token, None, "application/vnd.github.jerry-maguire-preview").await?
        }
        Kind::Gitlab => {
            let path = urlencoding(&format!("{owner}/{name}"));
            crate::host_api::list(&format!("https://{host}/api/v4/projects/{path}/users?per_page=100"), &token, None)
                .await?
        }
    };
    Ok(items.iter().filter_map(|item| mentionable_user(host, kind, item)).collect())
}

fn mentionable_user(host: &str, kind: Kind, item: &serde_json::Value) -> Option<MentionableUser> {
    let text = |key: &str| item.get(key).and_then(|v| v.as_str()).filter(|v| !v.is_empty()).map(str::to_string);
    let avatar_url = text("avatar_url").unwrap_or_default();
    match kind {
        Kind::Github => {
            let login = text("login")?;
            // Desktop GitHubUserStore.updateMentionables：没有可归属的邮箱就用旧式 noreply；
            // getStealthEmailHostForEndpoint 只给 GHES 用自己的主机名，github.com 和 *.ghe.com 都是 github.com
            let email = text("email").unwrap_or_else(|| {
                let server = hostname(host);
                let ghes = server != "github.com" && !server.ends_with(".ghe.com");
                let noreply = if ghes { format!("users.noreply.{server}") } else { "users.noreply.github.com".into() };
                format!("{login}@{noreply}")
            });
            Some(MentionableUser { login, name: text("name"), email, avatar_url })
        }
        Kind::Gitlab => {
            let login = text("username")?;
            // GitLab 私有提交邮箱：<id>-<username>@users.noreply.<实例主机名>
            let email = text("public_email").or_else(|| {
                let id = item.get("id")?.as_u64()?;
                Some(format!("{id}-{login}@users.noreply.{}", hostname(host)))
            })?;
            Some(MentionableUser { login, name: text("name"), email, avatar_url })
        }
    }
}

/// 手填共同作者用户名的精确解析。GitHub 由前端 Desktop GitHubUserStore.getByLogin 处理；
/// GitLab 账号不在 Desktop 账号库里，在这里按用户名查。查不到是 None，不是错误
pub async fn mentionable_user_by_login(host: &str, login: &str) -> Result<Option<MentionableUser>, String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;
    if kind != Kind::Gitlab {
        return Ok(None);
    }
    let url = format!("https://{host}/api/v4/users?username={}", urlencoding(login));
    let users = crate::host_api::get(&url, &token).await?;
    Ok(users
        .as_array()
        .into_iter()
        .flatten()
        // GitLab 的 username 查询不分大小写；只认真正同名的那个
        .find(|user| user.get("username").and_then(|v| v.as_str()).is_some_and(|v| v.eq_ignore_ascii_case(login)))
        .and_then(|user| mentionable_user(host, kind, user)))
}

/// `host[:port][/sub/path]` 里的主机名
fn hostname(host: &str) -> &str {
    let host = host.split('/').next().unwrap_or(host);
    host.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map_or(host, |(h, _)| h)
}

/// Fork 一个仓库到自己名下，返回克隆地址。
pub async fn fork_repo(host: &str, owner: &str, name: &str) -> Result<String, String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;
    let (url, field) = fork_endpoint(host, owner, name, kind);
    let v = post(&url, &token, &serde_json::json!({})).await?;
    v.get(field).and_then(|u| u.as_str()).map(str::to_string).ok_or_else(|| describe_api_error(&v))
}

fn fork_endpoint(host: &str, owner: &str, name: &str, kind: Kind) -> (String, &'static str) {
    match kind {
        Kind::Github => (format!("{}/repos/{owner}/{name}/forks", github_base(host)), "clone_url"),
        Kind::Gitlab => (
            format!("https://{host}/api/v4/projects/{}/fork", urlencoding(&format!("{owner}/{name}"))),
            "http_url_to_repo",
        ),
    }
}

/// 这个仓库 fork 自哪里。没有上游就是 None。
pub async fn upstream_of(host: &str, owner: &str, name: &str) -> Option<String> {
    let (account, token) = authenticated(host).await.ok()?;
    let kind = account.kind?;
    let (url, parent, field) = match kind {
        Kind::Github => (format!("{}/repos/{owner}/{name}", github_base(host)), "parent", "full_name"),
        Kind::Gitlab => (
            format!("https://{host}/api/v4/projects/{}", urlencoding(&format!("{owner}/{name}"))),
            "forked_from_project",
            "path_with_namespace",
        ),
    };
    let v = get(&url, &token).await?;
    let full = v.get(parent)?.get(field)?.as_str()?;
    Some(full.to_string())
}

/// 一个提交上的检查项。CI 挂了要能看出是哪个 job 挂的。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    #[serde(default)]
    pub id: u64,
    #[serde(default)]
    pub check_suite_id: Option<u64>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub app_name: String,
    #[serde(default)]
    pub workflow: Option<serde_json::Value>,
    #[serde(default)]
    pub rerunnable: bool,

    pub name: String,
    /// queued / in_progress / completed
    pub status: String,
    /// success / failure / cancelled / skipped …
    pub conclusion: Option<String>,
    pub url: String,
    pub retry: Option<CheckRetry>,
    #[serde(default)]
    pub job_id: Option<u64>,
    #[serde(default)]
    pub steps: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckRetry {
    GithubWorkflow { id: u64 },
    GithubCheckSuite { id: u64 },
    GitlabJob { id: u64 },
}

pub async fn check_runs(host: &str, owner: &str, name: &str, sha: &str) -> Result<Vec<CheckRun>, String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;
    if kind == Kind::Gitlab {
        let project = urlencoding(&format!("{owner}/{name}"));
        let url = format!(
            "https://{host}/api/v4/projects/{project}/repository/commits/{}/statuses?per_page=100",
            urlencoding(sha)
        );
        let items = crate::host_api::list(&url, &token, None).await?;
        let pipelines = crate::host_api::list(
            &format!("https://{host}/api/v4/projects/{project}/pipelines?sha={}&per_page=100", urlencoding(sha)),
            &token,
            None,
        )
        .await?;
        let mut jobs = std::collections::HashSet::new();
        for pipeline in pipelines {
            let Some(id) = pipeline["id"].as_u64() else { continue };
            let entries = crate::host_api::list(
                &format!("https://{host}/api/v4/projects/{project}/pipelines/{id}/jobs?per_page=100"),
                &token,
                None,
            )
            .await?;
            jobs.extend(entries.iter().filter_map(|job| job["id"].as_u64()));
        }
        return Ok(items
            .iter()
            .filter_map(|item| {
                let mut run = gitlab_check_run(item)?;
                run.retry = item["id"].as_u64().filter(|id| jobs.contains(id)).map(|id| CheckRetry::GitlabJob { id });
                Some(run)
            })
            .collect());
    }
    let url = format!("{}/repos/{owner}/{name}/commits/{sha}/check-runs", github_base(host));
    let items = crate::host_api::list(&url, &token, Some("check_runs")).await?;
    let workflows = crate::host_api::list(
        &format!("{}/repos/{owner}/{name}/actions/runs?head_sha={}&per_page=100", github_base(host), urlencoding(sha)),
        &token,
        Some("workflow_runs"),
    )
    .await?;
    let mut jobs = Vec::new();
    for workflow in &workflows {
        if let Some(id) = workflow["id"].as_u64() {
            jobs.extend(
                crate::host_api::list(
                    &format!("{}/repos/{owner}/{name}/actions/runs/{id}/jobs?per_page=100", github_base(host)),
                    &token,
                    Some("jobs"),
                )
                .await?,
            );
        }
    }
    Ok(items
        .iter()
        .filter_map(|it| {
            let job = jobs.iter().find(|job| {
                job["check_run_url"].as_str().is_some_and(|url| {
                    url.rsplit('/').next().and_then(|id| id.parse::<u64>().ok()) == it["id"].as_u64()
                })
            });
            let workflow = github_retry(it, &workflows).and_then(|retry| match retry {
                CheckRetry::GithubWorkflow { id } => {
                    workflows.iter().find(|run| run["id"].as_u64() == Some(id)).cloned()
                }
                _ => None,
            });
            Some(CheckRun {
                id: it["id"].as_u64().unwrap_or(0),
                check_suite_id: it["check_suite"]["id"].as_u64(),
                description: it["output"]["title"].as_str().unwrap_or("").into(),
                app_name: it["app"]["name"].as_str().unwrap_or("").into(),
                rerunnable: it["status"].as_str() == Some("completed"),
                workflow,
                name: it.get("name")?.as_str()?.to_string(),
                status: it.get("status")?.as_str()?.to_string(),
                conclusion: it.get("conclusion").and_then(|c| c.as_str()).map(str::to_string),
                url: it.get("html_url").and_then(|u| u.as_str()).unwrap_or("").to_string(),
                retry: github_retry(it, &workflows),
                job_id: job.and_then(|job| job["id"].as_u64()),
                steps: job.and_then(|job| job["steps"].as_array()).cloned().unwrap_or_default(),
            })
        })
        .collect())
}

/// Desktop rerun dialog: read eligibility only when the user opens confirmation.
/// A failed eligibility request leaves the dialog retryable; it does not start CI.
pub async fn check_rerun_eligibility(
    host: &str, owner: &str, name: &str, checks: Vec<CheckRun>,
) -> Result<Vec<u64>, String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or("Unknown hosting platform")?;
    let mut eligible = Vec::new();
    let mut suites = HashMap::new();
    for check in checks {
        if check.retry.is_none() || check.status != "completed" {
            continue;
        }
        match kind {
            Kind::Github => {
                let Some(id) = check.check_suite_id else {
                    continue;
                };
                let suite = match suites.entry(id) {
                    std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        let url = format!(
                            "{}/repos/{}/{}/check-suites/{id}",
                            github_base(host),
                            urlencoding(owner),
                            urlencoding(name)
                        );
                        entry.insert(crate::host_api::get(&url, &token).await?)
                    }
                };
                if suite_rerunnable(suite) {
                    eligible.push(check.id);
                }
            }
            Kind::Gitlab => {
                if let Some(CheckRetry::GitlabJob { id }) = check.retry {
                    let url =
                        format!("https://{host}/api/v4/projects/{}/jobs/{id}", urlencoding(&format!("{owner}/{name}")));
                    let job = crate::host_api::get(&url, &token).await?;
                    if matches!(job["status"].as_str(), Some("success" | "failed" | "canceled")) {
                        eligible.push(check.id);
                    }
                }
            }
        }
    }
    Ok(eligible)
}

fn suite_rerunnable(suite: &serde_json::Value) -> bool {
    if suite["status"].as_str() != Some("completed") || suite["rerequestable"].as_bool() != Some(true) {
        return false;
    }
    let Some(created) = suite["created_at"].as_str().and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
    else {
        return false;
    };
    created > chrono::Utc::now() - chrono::Duration::days(30)
}

fn gitlab_check_run(it: &serde_json::Value) -> Option<CheckRun> {
    let state = it.get("status")?.as_str()?;
    let (status, conclusion) = match state {
        "success" => ("completed", Some("success")),
        "failed" => ("completed", Some("failure")),
        "canceled" => ("completed", Some("cancelled")),
        "skipped" => ("completed", Some("skipped")),
        "running" => ("in_progress", None),
        _ => ("queued", None),
    };
    Some(CheckRun {
        id: it["id"].as_u64().unwrap_or(0),
        check_suite_id: it["check_suite"]["id"].as_u64(),
        description: it["description"].as_str().unwrap_or("").into(),
        app_name: String::new(),
        workflow: None,
        rerunnable: status == "completed",
        name: it.get("name")?.as_str()?.into(),
        status: status.into(),
        conclusion: conclusion.map(str::to_string),
        url: it.get("target_url").and_then(|v| v.as_str()).unwrap_or("").into(),
        retry: None,
        job_id: None,
        steps: Vec::new(),
    })
}

// Check run ID、check suite ID 和 workflow run ID 是三个不同的编号。
fn github_retry(check: &serde_json::Value, workflows: &[serde_json::Value]) -> Option<CheckRetry> {
    let suite = check["check_suite"]["id"].as_u64()?;
    workflows
        .iter()
        .find_map(|run| {
            (run["check_suite_id"].as_u64() == Some(suite))
                .then(|| run["id"].as_u64().map(|id| CheckRetry::GithubWorkflow { id }))
                .flatten()
        })
        .or_else(|| (suite > 0).then_some(CheckRetry::GithubCheckSuite { id: suite }))
}

fn retry_endpoint(host: &str, owner: &str, name: &str, kind: Kind, target: CheckRetry) -> Result<String, String> {
    match (kind, target) {
        (Kind::Github, CheckRetry::GithubCheckSuite { id }) if id > 0 => Ok(format!(
            "{}/repos/{}/{}/check-suites/{id}/rerequest",
            github_base(host),
            urlencoding(owner),
            urlencoding(name)
        )),
        (Kind::Github, CheckRetry::GithubWorkflow { id }) if id > 0 => Ok(format!(
            "{}/repos/{}/{}/actions/runs/{id}/rerun-failed-jobs",
            github_base(host),
            urlencoding(owner),
            urlencoding(name)
        )),
        (Kind::Gitlab, CheckRetry::GitlabJob { id }) if id > 0 => {
            Ok(format!("https://{host}/api/v4/projects/{}/jobs/{id}/retry", urlencoding(&format!("{owner}/{name}"))))
        }
        _ => Err("重跑目标无效或与托管平台不匹配".into()),
    }
}

pub async fn rerun_failed_jobs(host: &str, owner: &str, name: &str, target: CheckRetry) -> Result<(), String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;
    let url = retry_endpoint(host, owner, name, kind, target)?;
    post(&url, &token, &serde_json::json!({})).await.map(|_| ())
}

/// Desktop supports all, failed, and individual Actions job reruns.
fn check_rerun_endpoint(
    host: &str, owner: &str, name: &str, kind: Kind, target: CheckRetry, mode: &str, job_id: Option<u64>,
) -> Result<String, String> {
    match (&kind, &target, mode, job_id) {
        (Kind::Github, CheckRetry::GithubWorkflow { .. }, "job", Some(id)) if id > 0 => Ok(format!(
            "{}/repos/{}/{}/actions/jobs/{id}/rerun",
            github_base(host),
            urlencoding(owner),
            urlencoding(name)
        )),
        (Kind::Github, CheckRetry::GithubWorkflow { id }, "all", _) if *id > 0 => Ok(format!(
            "{}/repos/{}/{}/actions/runs/{id}/rerun",
            github_base(host),
            urlencoding(owner),
            urlencoding(name)
        )),
        (Kind::Github, CheckRetry::GithubCheckSuite { .. }, "all", _)
        | (_, _, "failed", _)
        | (Kind::Gitlab, CheckRetry::GitlabJob { .. }, "all" | "job", _) => {
            retry_endpoint(host, owner, name, kind, target)
        }
        _ => Err("无效重跑方式".into()),
    }
}

pub async fn rerun_check(
    host: &str, owner: &str, name: &str, target: CheckRetry, mode: &str, job_id: Option<u64>,
) -> Result<(), String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;
    let url = check_rerun_endpoint(host, owner, name, kind, target, mode, job_id)?;
    post(&url, &token, &serde_json::json!({})).await.map(|_| ())
}

/// 新建 PR / MR。返回它的网页地址。
pub async fn create_pull_request(
    host: &str, owner: &str, name: &str, title: &str, body: &str, head: &str, base: &str,
) -> Result<String, String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;

    let (url, payload, link_field) = match kind {
        Kind::Github => (
            format!("{}/repos/{owner}/{name}/pulls", github_base(host)),
            serde_json::json!({ "title": title, "body": body, "head": head, "base": base }),
            "html_url",
        ),
        Kind::Gitlab => {
            let path = urlencoding(&format!("{owner}/{name}"));
            (
                format!("https://{host}/api/v4/projects/{path}/merge_requests"),
                serde_json::json!({
                    "title": title,
                    "description": body,
                    "source_branch": head,
                    "target_branch": base,
                }),
                "web_url",
            )
        }
    };

    let v = post(&url, &token, &payload).await?;
    v.get(link_field)
        .and_then(|u| u.as_str())
        .map(str::to_string)
        // 失败时把服务端那句话带出来：「分支还没推上去」「已经有一个同源 PR」
        // 这类信息只有它知道
        .ok_or_else(|| describe_api_error(&v))
}

/// 在远端建一个空仓库，用于「发布」本地仓库。返回克隆地址。
pub async fn create_remote_repo(host: &str, name: &str, private: bool) -> Result<String, String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;

    let (url, payload, link_field) = match kind {
        Kind::Github => (
            format!("{}/user/repos", github_base(host)),
            serde_json::json!({ "name": name, "private": private }),
            "clone_url",
        ),
        Kind::Gitlab => (
            format!("https://{host}/api/v4/projects"),
            serde_json::json!({
                "name": name,
                "visibility": if private { "private" } else { "public" },
            }),
            "http_url_to_repo",
        ),
    };

    let v = post(&url, &token, &payload).await?;
    v.get(link_field).and_then(|u| u.as_str()).map(str::to_string).ok_or_else(|| describe_api_error(&v))
}

/// API 的错误体两家格式不同，都尽量把人能看懂的那句挖出来
fn describe_api_error(v: &serde_json::Value) -> String {
    // GitHub: { message, errors: [{ message }] }
    if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
        let detail = v
            .get("errors")
            .and_then(|e| e.as_array())
            .and_then(|a| a.first())
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str());
        return match detail {
            Some(d) => format!("{msg}: {d}"),
            None => msg.to_string(),
        };
    }
    // GitLab: { message: [...] } 或 { error: "..." }
    if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
        return e.to_string();
    }
    "接口返回了看不懂的内容".to_string()
}

async fn post(url: &str, token: &str, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    crate::host_api::post(url, token, payload).await
}

/// GitLab 的流水线状态词比 GitHub 多，归一到 success / failure / pending 三档
fn normalize_pipeline(status: &str) -> String {
    match status {
        "success" => "success",
        "failed" | "canceled" => "failure",
        _ => "pending",
    }
    .to_string()
}

fn field_str(v: &serde_json::Value, path: &[&str]) -> String {
    let mut cur = v;
    for key in path {
        match cur.get(key) {
            Some(next) => cur = next,
            None => return String::new(),
        }
    }
    cur.as_str().unwrap_or("").to_string()
}

/// 仓库元信息：私有 / fork。选图标用，取不到就按普通公开仓画。
pub async fn repo_meta(host: &str, owner: &str, name: &str, kind: Kind) -> Option<RepoMeta> {
    let token = credentials::find_async(host).await?.token;
    match kind {
        Kind::Github => {
            let base = github_base(host);
            let v = get(&format!("{base}/repos/{owner}/{name}"), &token).await?;
            Some(RepoMeta {
                private: v.get("private")?.as_bool().unwrap_or(false),
                fork: v.get("fork").and_then(|v| v.as_bool()).unwrap_or(false),
            })
        }
        Kind::Gitlab => {
            let path = urlencoding(&format!("{owner}/{name}"));
            let v = get(&format!("https://{host}/api/v4/projects/{path}"), &token).await?;
            Some(RepoMeta {
                private: v.get("visibility").and_then(|v| v.as_str()) != Some("public"),
                fork: v.get("forked_from_project").is_some_and(|v| !v.is_null()),
            })
        }
    }
}

/// 只有路径要转义，用不着为此拉一个依赖
fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// 自建实例可能压根连不上，不设超时就会把界面吊在那儿
fn client() -> &'static reqwest::Client {
    crate::host_api::client()
}

/// 失败只记日志——这不是关键路径，判不出归属最多是分组落到第三方、
/// 图标退回普通仓库，不该让界面报错。
async fn get(url: &str, token: &str) -> Option<serde_json::Value> {
    let res = client()
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(token)
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() => r.json().await.ok(),
        Ok(r) => {
            log::warn!("请求 {url} 失败: HTTP {}", r.status());
            None
        }
        Err(e) => {
            log::warn!("请求 {url} 失败: {e}");
            None
        }
    }
}

/// Import the same native credential into the GitHub-only Desktop stores.
/// A transient service failure must not be interpreted as signing out.
pub async fn desktop_session(host: &str) -> Result<Option<(String, String)>, String> {
    crate::oauth::refresh(host).await?;
    let Some(found) = credentials::find_async(host).await else {
        return Ok(None);
    };
    let account = identify(host, &found, false).await?;
    match account.kind {
        Some(Kind::Github) => Ok(Some((github_base(host), found.token))),
        Some(Kind::Gitlab) => Ok(None),
        None => Err(format!("Unable to verify the account on {host}")),
    }
}

/// Desktop getNonForkGitHubRepository: fork contributions default to their parent.
pub async fn pull_request_repository(host: &str, owner: &str, name: &str) -> Result<crate::remote::Remote, String> {
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;
    let url = match kind {
        Kind::Github => format!("{}/repos/{}/{}", github_base(host), urlencoding(owner), urlencoding(name)),
        Kind::Gitlab => format!("https://{host}/api/v4/projects/{}", urlencoding(&format!("{owner}/{name}"))),
    };
    let metadata = crate::host_api::get(&url, &token).await?;
    contribution_repository(host, owner, name, kind, &metadata)
}

fn contribution_repository(
    host: &str, owner: &str, name: &str, kind: Kind, metadata: &serde_json::Value,
) -> Result<crate::remote::Remote, String> {
    let (parent, field) = match kind {
        Kind::Github => ("parent", "full_name"),
        Kind::Gitlab => ("forked_from_project", "path_with_namespace"),
    };
    if let Some(parent) = metadata.get(parent).filter(|p| !p.is_null()) {
        let full = parent[field].as_str().ok_or("Parent repository name is missing")?;
        let (owner, name) = full.rsplit_once('/').ok_or("Invalid parent repository name")?;
        return Ok(crate::remote::Remote { host: host.into(), owner: owner.into(), name: name.into() });
    }
    Ok(crate::remote::Remote { host: host.into(), owner: owner.into(), name: name.into() })
}

/// Resolve the source repository, not just its potentially ambiguous branch name.
pub async fn pull_request_source(
    host: &str, owner: &str, name: &str, number: u64,
) -> Result<serde_json::Value, String> {
    if number == 0 {
        return Err("Invalid pull request number".into());
    }
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;
    let (project, branch) = match kind {
        Kind::Github => {
            let url =
                format!("{}/repos/{}/{}/pulls/{number}", github_base(host), urlencoding(owner), urlencoding(name));
            let detail = crate::host_api::get(&url, &token).await?;
            (detail["head"]["repo"].clone(), field_str(&detail, &["head", "ref"]))
        }
        Kind::Gitlab => {
            let base = format!("https://{host}/api/v4/projects");
            let url = format!("{base}/{}/merge_requests/{number}", urlencoding(&format!("{owner}/{name}")));
            let detail = crate::host_api::get(&url, &token).await?;
            let id = detail["source_project_id"].as_u64().ok_or("MR source project has been deleted")?;
            (crate::host_api::get(&format!("{base}/{id}"), &token).await?, field_str(&detail, &["source_branch"]))
        }
    };
    let clone_url = project[if kind == Kind::Github { "clone_url" } else { "http_url_to_repo" }]
        .as_str()
        .ok_or("Pull request source repository has been deleted")?;
    let source = source_within(clone_url, host);
    let Some(source) = source.filter(|_| !branch.is_empty()) else {
        return Err("Pull request source does not belong to this host or has no branch".into());
    };
    Ok(serde_json::json!({"number": number, "owner": source.owner, "cloneUrl": clone_url,
        "branch": branch, "kind": kind, "target": {"host": host, "owner": owner, "name": name}}))
}

/// 源仓库的克隆地址必须落在同一个实例下（子路径实例按完整基址），owner 相对实例。
fn source_within(clone_url: &str, host: &str) -> Option<crate::remote::Remote> {
    crate::remote::within(&crate::remote::parse(clone_url)?, host)
}

/// Repository metadata for the platform's native pull-request creation page.
pub async fn pull_request_targets(remote: &crate::remote::Remote) -> Result<serde_json::Value, String> {
    let host = &remote.host;
    let owner = &remote.owner;
    let name = &remote.name;
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;
    let base = match kind {
        Kind::Github => format!("{}/repos/{}/{}", github_base(host), urlencoding(owner), urlencoding(name)),
        Kind::Gitlab => format!("https://{host}/api/v4/projects/{}", urlencoding(&format!("{owner}/{name}"))),
    };
    let source = crate::host_api::get(&base, &token).await?;
    let parent = match kind {
        Kind::Github => "parent",
        Kind::Gitlab => "forked_from_project",
    };
    let mut targets = Vec::new();
    // Prefer the parent for forks, matching Desktop's contribution target.
    for value in source.get(parent).into_iter().chain(std::iter::once(&source)) {
        let (full, id) = match kind {
            Kind::Github => (value["full_name"].as_str(), value["id"].as_u64()),
            Kind::Gitlab => (value["path_with_namespace"].as_str(), value["id"].as_u64()),
        };
        let full = full.ok_or("缺少目标仓库名称")?;
        let url = match kind {
            Kind::Github => format!("{}/repos/{full}/branches?per_page=100", github_base(host)),
            Kind::Gitlab => {
                format!("https://{host}/api/v4/projects/{}/repository/branches?per_page=100", urlencoding(full))
            }
        };
        let branches = crate::host_api::list(&url, &token, None).await?;
        targets.push(serde_json::json!({"fullName": full, "id": id, "defaultBranch": value["default_branch"],
            "branches": branches.iter().filter_map(|b| b["name"].as_str()).collect::<Vec<_>>() }));
    }
    Ok(serde_json::json!({"kind": kind, "sourceId": source["id"], "remote": remote, "targets": targets}))
}

pub async fn branch_policy(remote: &crate::remote::Remote, branch: &str) -> Result<serde_json::Value, String> {
    let host = &remote.host;
    let (account, token) = authenticated(host).await?;
    let kind = account.kind.ok_or_else(|| format!("无法识别 {host} 的托管平台"))?;
    let base = match kind {
        Kind::Github => {
            format!("{}/repos/{}/{}", github_base(host), urlencoding(&remote.owner), urlencoding(&remote.name))
        }
        Kind::Gitlab => {
            format!("https://{host}/api/v4/projects/{}", urlencoding(&format!("{}/{}", remote.owner, remote.name)))
        }
    };
    let metadata = crate::host_api::get(&base, &token).await?;
    let branch_url = match kind {
        Kind::Github => format!("{base}/branches/{}", urlencoding(branch)),
        Kind::Gitlab => format!("{base}/repository/branches/{}", urlencoding(branch)),
    };
    let branch_info = match crate::host_api::get(&branch_url, &token).await {
        Ok(value) => value,
        Err(error) if error.starts_with("HTTP 404") => serde_json::Value::Null, // unpublished branch
        // Desktop fetchPushControl 失败只记日志、当作可推送（api.ts 1654-1687），提交框不显示错误。
        Err(error) => {
            log::info!("[branch_policy] unable to check if branch is potentially pushable: {error}");
            serde_json::Value::Null
        }
    };
    let no_write = match kind {
        Kind::Github => metadata["permissions"]["push"].as_bool() == Some(false),
        Kind::Gitlab => {
            branch_info["can_push"].as_bool() == Some(false) || {
                let project = metadata["permissions"]["project_access"]["access_level"].as_u64();
                let group = metadata["permissions"]["group_access"]["access_level"].as_u64();
                project.into_iter().chain(group).max().is_some_and(|level| level < 30)
            }
        }
    };
    let (rules, rulesets) = match kind {
        Kind::Github => github_branch_rules(&base, branch, &token).await,
        Kind::Gitlab => (Vec::new(), Vec::new()),
    };
    Ok(serde_json::json!({"remote": remote, "kind": kind, "metadata": metadata,
        "protected": branch_info["protected"].as_bool().unwrap_or(false), "noWrite": no_write,
        "rules": rules, "rulesets": rulesets}))
}

/// 分支规则与所属规则集。Desktop 取不到时只记日志、按没有规则处理（api.ts fetchRepoRulesForBranch
/// 1716-1739 返回空数组，fetchRepoRuleset 1773-1787 返回 null），404 与「未启用规则集」连日志也不记；
/// 断网或接口出错时提交框因此保持安静。
async fn github_branch_rules(
    base: &str, branch: &str, token: &str,
) -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
    let path = format!("{base}/rules/branches/{}?per_page=100", urlencoding(branch));
    let rules = match crate::host_api::list(&path, token, None).await {
        Ok(value) => value,
        Err(error) => {
            if !error.starts_with("HTTP 404") {
                log::info!(
                    "[fetchRepoRulesForBranch] unable to fetch repo rules for branch: {branch} | {path}: {error}"
                );
            }
            Vec::new()
        }
    };
    let ids: std::collections::BTreeSet<_> = rules.iter().filter_map(|rule| rule["ruleset_id"].as_u64()).collect();
    let mut rulesets = Vec::new();
    for id in ids {
        let path = format!("{base}/rulesets/{id}");
        match crate::host_api::get(&path, token).await {
            Ok(value) => rulesets.push(value),
            Err(error) => log::info!("[fetchRepoRuleset] unable to fetch repo ruleset for ID: {id} | {path}: {error}"),
        }
    }
    (rules, rulesets)
}

#[cfg(test)]
mod tests {
    #[test]
    fn mentionable_users_fall_back_to_platform_noreply_addresses() {
        let github =
            serde_json::json!({"login": "octo", "name": "Octo Cat", "email": null, "avatar_url": "https://a/1"});
        let user = mentionable_user("github.com", Kind::Github, &github).unwrap();
        assert_eq!(user.email, "octo@users.noreply.github.com");
        assert_eq!(user.name.as_deref(), Some("Octo Cat"));
        assert_eq!(
            mentionable_user("acme.ghe.com", Kind::Github, &github).unwrap().email,
            "octo@users.noreply.github.com"
        );
        assert_eq!(
            mentionable_user("git.example:8443", Kind::Github, &github).unwrap().email,
            "octo@users.noreply.git.example"
        );
        let public = serde_json::json!({"login": "octo", "email": "octo@example.test"});
        assert_eq!(mentionable_user("github.com", Kind::Github, &public).unwrap().email, "octo@example.test");

        let gitlab = serde_json::json!({"id": 42, "username": "dev", "name": "Dev", "public_email": ""});
        assert_eq!(
            mentionable_user("gitlab.example:8443/sub/path", Kind::Gitlab, &gitlab).unwrap().email,
            "42-dev@users.noreply.gitlab.example"
        );
        let shown = serde_json::json!({"id": 42, "username": "dev", "public_email": "dev@example.test"});
        assert_eq!(mentionable_user("gitlab.com", Kind::Gitlab, &shown).unwrap().email, "dev@example.test");
        assert!(mentionable_user("gitlab.com", Kind::Gitlab, &serde_json::json!({"id": 1})).is_none());
    }

    #[test]
    fn identity_requests_coalesce_and_changed_credentials_bypass_cache() {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        tauri::async_runtime::block_on(async {
            let calls = Arc::new(AtomicUsize::new(0));
            let mut tasks = Vec::new();
            for _ in 0..12 {
                let calls = calls.clone();
                tasks.push(tauri::async_runtime::spawn(async move {
                    cached_identity("identity-cache-test", "old-token", false, async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Err("HTTP 403 Forbidden: API rate limit exceeded".into())
                    })
                    .await
                }));
            }
            for task in tasks {
                assert!(task.await.unwrap().unwrap_err().contains("403"));
            }
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let account = cached_identity("identity-cache-test", "new-token", false, async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(Account { login: Some("new-user".into()), ..Account::default() })
            })
            .await
            .unwrap();
            assert_eq!(account.login.as_deref(), Some("new-user"));
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            let slot = IDENTITIES.lock().unwrap().get("identity-cache-test").unwrap().clone();
            slot.lock().await.as_mut().unwrap().expires = Instant::now();
            cached_identity("identity-cache-test", "new-token", false, async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(Account::default())
            })
            .await
            .unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 3);
        });
    }
    use super::*;

    /// 后台消费者共用一次失败的结果，但用户点刷新时必须立刻重试：网络恢复后不能再等一分钟。
    #[test]
    fn explicit_refresh_retries_a_cached_identity_failure() {
        tauri::async_runtime::block_on(async {
            let host = "identity-refresh-test";
            let back = || Ok(Account { login: Some("back".into()), ..Account::default() });
            let failed =
                cached_identity(host, "token", false, async { Err("请求失败: connection refused".into()) }).await;
            assert!(failed.is_err());
            assert!(cached_identity(host, "token", false, async { back() }).await.is_err());
            let recovered = cached_identity(host, "token", true, async { back() }).await.unwrap();
            assert_eq!(recovered.login.as_deref(), Some("back"));
            // 恢复后的结果替换掉失败；新鲜的成功结果刷新时也不重拉。
            for refresh in [false, true] {
                let kept = cached_identity(host, "token", refresh, async { Err("unexpected".into()) }).await.unwrap();
                assert_eq!(kept.login.as_deref(), Some("back"));
            }
        });
    }

    /// 自建实例连不上时只连一次：不再为 GitHub Enterprise 探测多等一个超时，错误也只报一个。
    #[test]
    fn unreachable_instance_is_not_probed_twice() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let host = format!("127.0.0.1:{}", listener.local_addr().unwrap().port());
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (counted, stopped) = (connections.clone(), stop.clone());
        // 纯 TCP 监听：TLS 握手失败就是传输错误，与断网、DNS 失败走同一条分支。
        let server = std::thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        counted.fetch_add(1, Ordering::SeqCst);
                        drop(stream);
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        let found = credentials::Found { token: "token".into(), source: Source::Settings, kind: None };
        let error = tauri::async_runtime::block_on(identify_uncached(&host, &found)).unwrap_err();
        std::thread::sleep(Duration::from_millis(300));
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
        assert!(is_transport_error(&error), "{error}");
        assert!(!error.contains("GitHub Enterprise"), "{error}");
        assert_eq!(connections.load(Ordering::SeqCst), 1);
    }

    /// GitLab 以 401 拒绝令牌：这台就是 GitLab，不再探测 GitHub Enterprise，错误里也没有它的尾巴。
    #[test]
    fn gitlab_rejecting_the_token_is_not_probed_as_github_enterprise() {
        use crate::host_api::mock::{response, serve};
        // 只备一条响应：多发的第二个请求在 mock 退出后只会被拒绝连接，合并错误里就会出现 GitHub Enterprise。
        let unauthorized = response("401 Unauthorized", "", r#"{"message":"401 Unauthorized"}"#);
        let (url, server) = serve(vec![unauthorized]);
        let found = credentials::Found { token: "token".into(), source: Source::Settings, kind: None };
        let error = tauri::async_runtime::block_on(identify_at("git.test", &found, &url, &format!("{url}/github")))
            .unwrap_err();
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /user "), "{}", requests[0]);
        assert_eq!(error, "GitLab: HTTP 401 Unauthorized：401 Unauthorized");
        assert!(is_unauthorized(&error));
        // 过期或吊销的 OAuth 令牌：GitLab 答 {"error":"invalid_token"}，同样只问 GitLab。
        // 令牌字面量不能是 "token"：host_api 会把错误正文里出现的令牌打码，连 invalid_token 一起改掉。
        let invalid = response("401 Unauthorized", "", r#"{"error":"invalid_token","error_description":"expired"}"#);
        let (url, server) = serve(vec![invalid]);
        let secret = credentials::Found { token: "secret".into(), source: Source::Settings, kind: None };
        let error = tauri::async_runtime::block_on(identify_at("git.test", &secret, &url, &format!("{url}/github")))
            .unwrap_err();
        assert_eq!(server.join().unwrap().len(), 1);
        assert_eq!(error, "GitLab: HTTP 401 Unauthorized：invalid_token");
        assert!(is_unauthorized(&error));
        // GitHub Enterprise 的 401 是 "Bad credentials"：分不清平台时照旧两家都问，两条都报。
        let bad = response("401 Unauthorized", "", r#"{"message":"Bad credentials"}"#);
        let (url, server) = serve(vec![bad.clone(), bad]);
        let error = tauri::async_runtime::block_on(identify_at("ghe.test", &found, &url, &url)).unwrap_err();
        assert_eq!(server.join().unwrap().len(), 2);
        assert_eq!(
            error,
            "GitLab: HTTP 401 Unauthorized：Bad credentials；GitHub Enterprise: HTTP 401 Unauthorized：Bad credentials"
        );
    }

    /// OAuth 登录时选过的平台记在凭据里：验证账号只问那一家，失败也只报那一家。
    #[test]
    fn a_known_platform_is_only_asked_as_itself() {
        use crate::host_api::mock::{response, serve};
        let (url, server) = serve(vec![response("500 Internal Server Error", "", "")]);
        let found = credentials::Found { token: "token".into(), source: Source::Settings, kind: Some(Kind::Gitlab) };
        let error = tauri::async_runtime::block_on(identify_at("git.test", &found, &url, &format!("{url}/github")))
            .unwrap_err();
        assert_eq!(server.join().unwrap().len(), 1);
        assert_eq!(error, "GitLab: HTTP 500 Internal Server Error");
        // 已知是 GitHub Enterprise 时同样只问一家、带平台前缀。
        let (url, server) = serve(vec![response("500 Internal Server Error", "", "")]);
        let found = credentials::Found { token: "token".into(), source: Source::Settings, kind: Some(Kind::Github) };
        let error = tauri::async_runtime::block_on(identify_at("ghe.test", &found, &format!("{url}/gitlab"), &url))
            .unwrap_err();
        assert_eq!(server.join().unwrap().len(), 1);
        assert_eq!(error, "GitHub Enterprise: HTTP 500 Internal Server Error");
        let (url, server) = serve(vec![response("200 OK", "", r#"{"login":"me"}"#), response("200 OK", "", "[]")]);
        let found = credentials::Found { token: "token".into(), source: Source::Settings, kind: Some(Kind::Github) };
        let account =
            tauri::async_runtime::block_on(identify_at("ghe.test", &found, &format!("{url}/gitlab"), &url)).unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /user "), "{}", requests[0]);
        assert_eq!(account.kind, Some(Kind::Github));
        assert_eq!(account.login.as_deref(), Some("me"));
    }

    /// 远端连不上或规则接口出错时，分支规则按 Desktop 的做法静默为空（api.ts fetchRepoRulesForBranch /
    /// fetchRepoRuleset 只记日志），提交框不显示「分支策略查询失败」。
    #[test]
    fn branch_rules_failures_are_silent_like_desktop() {
        use crate::host_api::mock::{response, serve};
        for status in ["503 Service Unavailable", "500 Internal Server Error", "404 Not Found"] {
            let (url, server) = serve(vec![response(status, "", "")]);
            let (rules, rulesets) = tauri::async_runtime::block_on(github_branch_rules(&url, "main", "token"));
            assert!(rules.is_empty() && rulesets.is_empty(), "{status}");
            server.join().unwrap();
        }
        // 规则读到了、某个规则集读不到：保留规则，缺失的规则集由前端 parseRepoRules 当作不存在。
        let rules = response("200 OK", "", r#"[{"type":"deletion","ruleset_id":7},{"type":"update","ruleset_id":7}]"#);
        let (url, server) = serve(vec![rules, response("502 Bad Gateway", "", "")]);
        let (rules, rulesets) = tauri::async_runtime::block_on(github_branch_rules(&url, "main", "token"));
        let requests = server.join().unwrap();
        assert_eq!(rules.len(), 2);
        assert!(rulesets.is_empty());
        assert!(requests[1].starts_with("GET /rulesets/7 "), "{}", requests[1]);
        // 规则接口连不上（端口已关闭，连接被拒）同样安静。
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{port}");
        let (rules, rulesets) = tauri::async_runtime::block_on(github_branch_rules(&base, "main", "token"));
        assert!(rules.is_empty() && rulesets.is_empty());
    }

    /// /user 成功但组织 / 群组列表读不到时不能算验证成功：否则 owners 只剩登录名，
    /// 组织下的仓库全跳到第三方，还覆盖掉上一次完整的结果。没有权限（403 / 404）才只用登录名。
    #[test]
    fn namespace_listing_failures_do_not_pass_as_success() {
        use crate::host_api::mock::{response, serve};
        let user = response("200 OK", "", r#"{"login":"me","username":"me"}"#);
        for status in ["503 Service Unavailable", "500 Internal Server Error"] {
            let (url, server) = serve(vec![user.clone(), response(status, "", "")]);
            let error =
                tauri::async_runtime::block_on(github("ghe.test", "token-a", Source::Settings, &url)).unwrap_err();
            assert!(error.contains("组织") && error.contains(&status[..3]), "{error}");
            server.join().unwrap();
            let (url, server) = serve(vec![user.clone(), response(status, "", "")]);
            let error = tauri::async_runtime::block_on(gitlab(&url, "token-b", Source::Settings)).unwrap_err();
            assert!(error.contains("组织") && error.contains(&status[..3]), "{error}");
            server.join().unwrap();
        }
        // GitHub 把限流也报成 403：带限流字样的仍是暂时失败。
        let limited = response("403 Forbidden", "Retry-After: 60\r\n", r#"{"message":"API rate limit exceeded"}"#);
        let (url, server) = serve(vec![user.clone(), limited]);
        let error = tauri::async_runtime::block_on(github("ghe.test", "token-c", Source::Settings, &url)).unwrap_err();
        assert!(error.contains("组织") && error.contains("rate limit"), "{error}");
        server.join().unwrap();
        // 令牌没有读组织的权限：登录名照常可用，不把账号整个判成失败。
        let forbidden = response("403 Forbidden", "", r#"{"message":"Forbidden"}"#);
        let (url, server) = serve(vec![user.clone(), forbidden.clone()]);
        let account = tauri::async_runtime::block_on(github("ghe.test", "token-d", Source::Settings, &url)).unwrap();
        assert_eq!(account.owners, vec!["me".to_string()]);
        server.join().unwrap();
        let (url, server) = serve(vec![user, forbidden]);
        let account = tauri::async_runtime::block_on(gitlab(&url, "token-e", Source::Settings)).unwrap();
        assert_eq!(account.owners, vec!["me".to_string()]);
        server.join().unwrap();
    }

    #[test]
    fn check_suite_eligibility_preserves_desktop_contract() {
        let mut suite = serde_json::json!({"status":"completed", "rerequestable":true,
            "created_at": (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339()});
        assert!(suite_rerunnable(&suite));
        suite["rerequestable"] = false.into();
        assert!(!suite_rerunnable(&suite));
        suite["rerequestable"] = true.into();
        suite["status"] = "in_progress".into();
        assert!(!suite_rerunnable(&suite));
        suite["status"] = "completed".into();
        suite["created_at"] = (chrono::Utc::now() - chrono::Duration::days(31)).to_rfc3339().into();
        assert!(!suite_rerunnable(&suite));
        suite["created_at"] = "invalid".into();
        assert!(!suite_rerunnable(&suite));
    }

    #[test]
    fn repository_metadata_is_optional_but_identity_is_required() {
        for (kind, path_field, url_field) in
            [(Kind::Github, "full_name", "clone_url"), (Kind::Gitlab, "path_with_namespace", "http_url_to_repo")]
        {
            let mut item = serde_json::json!({
                path_field: "group/sub/project",
                url_field: "https://git.example:8443/group/sub/project.git"
            });
            for null_metadata in [false, true] {
                if null_metadata {
                    item["description"] = serde_json::Value::Null;
                    item["language"] = serde_json::Value::Null;
                }
                let repo = remote_repo("git.example:8443", kind, &item).unwrap();
                assert_eq!(repo.owner, "group/sub");
                assert_eq!(repo.name, "project");
                assert_eq!(repo.host, "git.example:8443");
                assert_eq!(repo.description, None);
                assert_eq!(repo.language, None);
                assert!(repo.private);
                assert!(!repo.fork);
            }
            for path in ["", "project", "/project", "group/"] {
                item[path_field] = path.into();
                assert!(remote_repo("git.example", kind, &item).is_err());
            }
            item[path_field] = "group/project".into();
            item[url_field] = serde_json::Value::Null;
            assert!(remote_repo("git.example", kind, &item).is_err());
        }
    }

    #[test]
    fn repository_metadata_preserves_platform_fields() {
        let github = remote_repo(
            "github.com",
            Kind::Github,
            &serde_json::json!({
                "full_name": "owner/repo", "clone_url": "https://github.com/owner/repo.git",
                "description": "description", "language": "Rust", "private": false,
                "fork": true, "stargazers_count": 42
            }),
        )
        .unwrap();
        assert_eq!(github.description.as_deref(), Some("description"));
        assert_eq!(github.language.as_deref(), Some("Rust"));
        assert_eq!(github.stars, 42);
        assert!(!github.private && github.fork);
        let gitlab = remote_repo(
            "git.example",
            Kind::Gitlab,
            &serde_json::json!({
                "path_with_namespace": "group/sub/repo", "http_url_to_repo": "https://git.example/group/sub/repo.git",
                "visibility": "public", "forked_from_project": {"id": 1}, "star_count": 12
            }),
        )
        .unwrap();
        assert_eq!(gitlab.stars, 12);
        assert!(!gitlab.private && gitlab.fork);
    }

    #[test]
    fn 检查状态仅聚合check_runs() {
        let checks = serde_json::json!([
            {"status":"completed", "conclusion":"success"},
            {"status":"completed", "conclusion":"skipped"}
        ]);
        assert_eq!(aggregate_checks(checks.as_array().unwrap()).as_deref(), Some("success"));
        assert_eq!(aggregate_checks(&[]), None);
        assert_eq!(aggregate_checks(&[serde_json::json!({"status":"in_progress"})]).as_deref(), Some("pending"));
        assert_eq!(
            aggregate_checks(&[serde_json::json!({"status":"completed","conclusion":"cancelled"})]).as_deref(),
            Some("cancelled")
        );
        for conclusion in ["failure", "timed_out", "action_required", "startup_failure"] {
            let runs = vec![
                serde_json::json!({"status":"completed","conclusion":conclusion}),
                serde_json::json!({"status":"in_progress"}),
            ];
            assert_eq!(aggregate_checks(&runs).as_deref(), Some("failure"));
        }
    }

    #[test]
    fn 重跑使用工作流编号而非检查编号或网页地址() {
        let check =
            serde_json::json!({"id":11,"check_suite":{"id":22},"html_url":"https://github.com/o/r/actions/runs/999"});
        let workflows =
            vec![serde_json::json!({"id":33,"check_suite_id":22}), serde_json::json!({"id":44,"check_suite_id":55})];
        let target = github_retry(&check, &workflows).unwrap();
        assert_eq!(target, CheckRetry::GithubWorkflow { id: 33 });
        assert_eq!(
            retry_endpoint("github.com", "o", "r", Kind::Github, target).unwrap(),
            "https://api.github.com/repos/o/r/actions/runs/33/rerun-failed-jobs"
        );
        assert_eq!(github_retry(&check, &[]), Some(CheckRetry::GithubCheckSuite { id: 22 }));
        assert_eq!(
            retry_endpoint("github.com", "o", "r", Kind::Github, CheckRetry::GithubCheckSuite { id: 22 }).unwrap(),
            "https://api.github.com/repos/o/r/check-suites/22/rerequest"
        );
        assert!(
            github_retry(&serde_json::json!({"html_url":"https://github.com/o/r/actions/runs/999"}), &workflows)
                .is_none()
        );
        assert_eq!(
            retry_endpoint("git.example:8443", "group/sub", "r", Kind::Gitlab, CheckRetry::GitlabJob { id: 77 })
                .unwrap(),
            "https://git.example:8443/api/v4/projects/group%2Fsub%2Fr/jobs/77/retry"
        );
        assert!(retry_endpoint("git.example", "o", "r", Kind::Gitlab, CheckRetry::GithubWorkflow { id: 33 }).is_err());
        assert!(retry_endpoint("github.com", "o", "r", Kind::Github, CheckRetry::GithubWorkflow { id: 0 }).is_err());
        assert_eq!(
            serde_json::to_value(CheckRetry::GitlabJob { id: 77 }).unwrap(),
            serde_json::json!({"kind":"gitlabJob","id":77})
        );
    }

    #[test]
    fn gitlab待评审查询不混淆指派人与评审人() {
        let url =
            reqwest::Url::parse(&gitlab_involved_url("git.example", InvolvedKind::ReviewRequested, "a+b")).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(query.get("scope").unwrap(), "all");
        assert_eq!(query.get("reviewer_username").unwrap(), "a+b");
        assert!(!query.contains_key("assignee_username"));
        assert!(gitlab_involved_url("git.example", InvolvedKind::Authored, "me").contains("scope=created_by_me"));
    }

    #[test]
    fn gitlab待办保留子组与项目内编号() {
        let mr = gitlab_involved_mr(
            "git.example",
            &serde_json::json!({
                "id": 999, "iid": 12, "title": "Review", "author": {"username": "alice"},
                "web_url": "https://git.example/group/sub/project/-/merge_requests/12",
                "head_pipeline": {"status": "failed"}
            }),
        )
        .unwrap();
        assert_eq!(mr.number, 12);
        assert_eq!(mr.head, "group/sub/project");
        assert_eq!(mr.checks.as_deref(), Some("failure"));
    }

    #[test]
    fn 子路径实例的待办与接口地址都按完整基址() {
        let mr = gitlab_involved_mr(
            "git.example:8443/gitlab",
            &serde_json::json!({
                "iid": 3, "title": "Review", "author": {"username": "alice"},
                "web_url": "https://git.example:8443/gitlab/group/sub/project/-/merge_requests/3"
            }),
        )
        .unwrap();
        assert_eq!(mr.head, "group/sub/project");
        assert!(
            gitlab_involved_url("git.example:8443/gitlab", InvolvedKind::Authored, "me")
                .starts_with("https://git.example:8443/gitlab/api/v4/merge_requests?")
        );
        let (url, _) = fork_endpoint("git.example/gitlab", "group/sub", "repo", Kind::Gitlab);
        assert_eq!(url, "https://git.example/gitlab/api/v4/projects/group%2Fsub%2Frepo/fork");
        let source = source_within("https://git.example/gitlab/fork-owner/sub/repo.git", "git.example/gitlab");
        assert_eq!(source.map(|r| r.owner).as_deref(), Some("fork-owner/sub"));
        assert!(source_within("https://git.example/group/repo.git", "git.example/gitlab").is_none());
        assert!(source_within("https://other.example/gitlab/group/repo.git", "git.example/gitlab").is_none());
    }

    #[test]
    fn fork按平台选择接口并保留子组() {
        let (url, field) = fork_endpoint("git.example:8443", "group/sub", "repo", Kind::Gitlab);
        assert_eq!(url, "https://git.example:8443/api/v4/projects/group%2Fsub%2Frepo/fork");
        assert_eq!(field, "http_url_to_repo");
        assert_eq!(
            fork_endpoint("github.com", "owner", "repo", Kind::Github).0,
            "https://api.github.com/repos/owner/repo/forks"
        );
        assert_eq!(
            fork_endpoint("github.example", "owner", "repo", Kind::Github).0,
            "https://github.example/api/v3/repos/owner/repo/forks"
        );
    }

    #[test]
    fn gitlab检查状态保留取消与跳过() {
        for (state, status, conclusion) in [
            ("success", "completed", Some("success")),
            ("failed", "completed", Some("failure")),
            ("canceled", "completed", Some("cancelled")),
            ("skipped", "completed", Some("skipped")),
            ("running", "in_progress", None),
            ("pending", "queued", None),
        ] {
            let run = gitlab_check_run(
                &serde_json::json!({"name":"test", "status":state, "target_url":"https://git.example/job/1"}),
            )
            .unwrap();
            assert_eq!(run.status, status);
            assert_eq!(run.conclusion.as_deref(), conclusion);
            assert_eq!(run.url, "https://git.example/job/1");
        }
    }
    #[test]
    fn 路径转义只留安全字符() {
        assert_eq!(super::urlencoding("alwith/alwith-desktop"), "alwith%2Falwith-desktop");
        assert_eq!(super::urlencoding("a.b-c_d~e"), "a.b-c_d~e");
    }
}

#[cfg(test)]
mod workflow_navigation_tests {
    use super::*;
    #[test]
    fn fork_contributions_resolve_parent_namespaces_and_enterprise_ports() {
        let github = contribution_repository(
            "github.example:8443",
            "me",
            "fork",
            Kind::Github,
            &serde_json::json!({"parent": {"full_name": "org/project"}}),
        )
        .unwrap();
        assert_eq!(github.host, "github.example:8443");
        assert_eq!(github.owner, "org");
        assert_eq!(github.name, "project");
        let gitlab = contribution_repository(
            "gitlab.example",
            "me",
            "fork",
            Kind::Gitlab,
            &serde_json::json!({"forked_from_project": {"path_with_namespace": "group/sub/project"}}),
        )
        .unwrap();
        assert_eq!(gitlab.owner, "group/sub");
        assert_eq!(gitlab.name, "project");
        assert_eq!(
            contribution_repository("gitlab.example", "me", "fork", Kind::Gitlab, &serde_json::json!({}))
                .unwrap()
                .owner,
            "me"
        );
        assert!(
            contribution_repository("github.com", "me", "fork", Kind::Github, &serde_json::json!({"parent": {}}))
                .is_err()
        );
    }
    #[test]
    fn 重跑方式分别使用工作流和任务编号() {
        let workflow = CheckRetry::GithubWorkflow { id: 33 };
        assert_eq!(
            check_rerun_endpoint("github.com", "o", "r", Kind::Github, workflow.clone(), "all", None).unwrap(),
            "https://api.github.com/repos/o/r/actions/runs/33/rerun"
        );
        assert_eq!(
            check_rerun_endpoint("github.com", "o", "r", Kind::Github, workflow.clone(), "failed", None).unwrap(),
            "https://api.github.com/repos/o/r/actions/runs/33/rerun-failed-jobs"
        );
        assert_eq!(
            check_rerun_endpoint("enterprise.example:8443", "o", "r", Kind::Github, workflow.clone(), "job", Some(77))
                .unwrap(),
            "https://enterprise.example:8443/api/v3/repos/o/r/actions/jobs/77/rerun"
        );
        assert!(check_rerun_endpoint("github.com", "o", "r", Kind::Github, workflow, "job", None).is_err());
    }
    #[test]
    fn 重跑不能混用平台且支持嵌套命名空间() {
        assert!(
            check_rerun_endpoint("github.com", "o", "r", Kind::Github, CheckRetry::GitlabJob { id: 1 }, "all", None)
                .is_err()
        );
        assert_eq!(
            check_rerun_endpoint(
                "git.example:8443",
                "group/sub",
                "r",
                Kind::Gitlab,
                CheckRetry::GitlabJob { id: 77 },
                "job",
                None
            )
            .unwrap(),
            "https://git.example:8443/api/v4/projects/group%2Fsub%2Fr/jobs/77/retry"
        );
    }
}
