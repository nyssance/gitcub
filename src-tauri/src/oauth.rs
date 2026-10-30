//! OAuth 设备码登录（RFC 8628）。
//!
//! 桌面端不该用回调端口那套：要起本地 HTTP 监听、要注册 redirect_uri、
//! 端口还可能被占。设备码流程只要「显示一串码 + 轮询」，两家都支持：
//!   GitHub：POST /login/device/code、POST /login/oauth/access_token
//!   GitLab：POST /oauth/authorize_device、POST /oauth/token（17.1 起，17.9 GA）
//! 都不需要 client secret。
//!
//! client_id 不是密钥，按实例存在 state.json 里——自建实例各有各的应用，
//! 写死一个没有意义（应用在 /user_settings/applications 用户自己就能建）。

use crate::{account::Kind, settings};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

const USER_AGENT: &str = concat!("GitCub/", env!("CARGO_PKG_VERSION"));

/// 要到的权限。够用就好，不多要：
///   GitHub repo / read:org / user:email / workflow / notifications cover the client workflows.
///   GitLab api（MR、CI 读写）+ write_repository（Git 推送）。
fn scope(kind: Kind) -> &'static str {
    if kind == Kind::Github { "repo read:org user:email workflow notifications" } else { "api write_repository" }
}

fn provider(host: &str, kind: Option<Kind>) -> Result<Kind, String> {
    match host {
        "github.com" => Ok(Kind::Github),
        "gitlab.com" => Ok(Kind::Gitlab),
        _ => kind.ok_or("Select GitHub Enterprise or GitLab for this instance".into()),
    }
}

/// 实例标识是 `host[:port][/子路径]`。GitLab 可以部署在子路径下，OAuth 端点跟着子路径走；
/// GitHub Enterprise Server 不支持子路径部署，带子路径的 GitHub 实例直接拒绝。
fn endpoint(host: &str, kind: Kind, start: bool) -> Result<String, String> {
    let (authority, subpath) = crate::remote::split_instance(host);
    let invalid = || "Expected an account hostname, optionally with a port and a GitLab sub-path".to_string();
    let base = reqwest::Url::parse(&format!("https://{authority}")).map_err(|_| "Invalid account host")?;
    if base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.path() != "/"
        || base.query().is_some()
        || base.fragment().is_some()
        || (!subpath.is_empty() && kind == Kind::Github)
        || host != if subpath.is_empty() { authority.to_string() } else { format!("{authority}/{subpath}") }
    {
        return Err(invalid());
    }
    let path = match (kind, start) {
        (Kind::Github, true) => "/login/device/code",
        (Kind::Github, false) => "/login/oauth/access_token",
        (Kind::Gitlab, true) => "/oauth/authorize_device",
        (Kind::Gitlab, false) => "/oauth/token",
    };
    if subpath.is_empty() {
        return base.join(path).map(|url| url.to_string()).map_err(|e| e.to_string());
    }
    // 子路径只允许普通路径段：不能借 `..`、查询串或片段把令牌请求指到实例之外。
    let url = reqwest::Url::parse(&format!("https://{authority}/{subpath}{path}")).map_err(|_| invalid())?;
    if url.path() != format!("/{subpath}{path}")
        || url.query().is_some()
        || url.fragment().is_some()
        || subpath.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(invalid());
    }
    Ok(url.to_string())
}

#[derive(Clone)]
struct Attempt {
    id: String,
    client: String,
    kind: Kind,
    device_code: Option<String>,
}
static ATTEMPTS: LazyLock<Mutex<HashMap<String, Attempt>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Mutations and final token persistence share a lock: a late response cannot undo sign-out.
pub fn change_account<T>(host: &str, change: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let mut attempts = ATTEMPTS.lock().map_err(|_| "Account session lock unavailable")?;
    attempts.remove(host);
    change()
}

pub fn cancel(host: &str, attempt_id: &str) -> Result<(), String> {
    let mut attempts = ATTEMPTS.lock().map_err(|_| "Account session lock unavailable")?;
    if attempts.get(host).is_some_and(|attempt| attempt.id == attempt_id) {
        attempts.remove(host);
    }
    Ok(())
}

fn finish_attempt<T>(host: &str, attempt_id: &str, save: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let mut attempts = ATTEMPTS.lock().map_err(|_| "Account session lock unavailable")?;
    if !attempts.get(host).is_some_and(|a| a.id == attempt_id) {
        return Err("Sign-in was cancelled or replaced".into());
    }
    let result = save()?;
    attempts.remove(host);
    Ok(result)
}

/// 内置的应用 ID。
///
/// client_id 不是密钥（设备码流程没有 client secret），写进代码是这类客户端的
/// 常规做法——GitHub Desktop、gh CLI 都这么干。有了它，用 github.com 的人零
/// 配置就能登录，设置里根本不用出现「应用 ID」那一行。
/// 自建实例各有各的应用，只能用户自己填。
pub fn default_client_id(host: &str) -> Option<&'static str> {
    match host {
        "github.com" => Some("Ov23liFcAs3TukpS70iz"),
        _ => None,
    }
}

/// 某个实例最终用哪个 client_id：用户填过就用他的，否则用内置的。
pub fn client_id_for(host: &str, user_set: Option<&str>) -> Option<String> {
    user_set
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| default_client_id(host).map(str::to_string))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    /// 给用户看的短码
    pub user_code: String,
    /// 让用户去输码的地址
    pub verification_uri: String,
    /// 已经带上码的地址，能直接打开就不用手输
    pub verification_uri_complete: Option<String>,
    pub device_code: String,
    /// 轮询间隔（秒）
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PollStatus {
    /// 用户还没在浏览器里点同意
    Pending,
    /// 轮太快了，下次间隔加 5 秒（RFC 8628 的要求）
    SlowDown,
    Done,
    Denied,
    Expired,
}

pub async fn device_start(
    host: &str, client_id: &str, kind: Option<Kind>, attempt_id: &str,
) -> Result<DeviceStart, String> {
    let kind = provider(host, kind)?;
    let url = endpoint(host, kind, true)?;
    ATTEMPTS
        .lock()
        .map_err(|_| "Account session lock unavailable")?
        .insert(host.into(), Attempt { id: attempt_id.into(), client: client_id.into(), kind, device_code: None });
    let v = post(&url, &[("client_id", client_id), ("scope", scope(kind))]).await?;

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(describe(err, &v));
    }

    let start = DeviceStart {
        user_code: field(&v, "user_code")?,
        verification_uri: field(&v, "verification_uri")?,
        verification_uri_complete: v.get("verification_uri_complete").and_then(|s| s.as_str()).map(str::to_string),
        device_code: field(&v, "device_code")?,
        interval: v.get("interval").and_then(|n| n.as_u64()).unwrap_or(5),
        expires_in: v.get("expires_in").and_then(|n| n.as_u64()).unwrap_or(900),
    };
    let mut attempts = ATTEMPTS.lock().map_err(|_| "Account session lock unavailable")?;
    let attempt = attempts.get_mut(host).filter(|a| a.id == attempt_id).ok_or("Sign-in was cancelled")?;
    attempt.device_code = Some(start.device_code.clone());
    Ok(start)
}

/// 轮询一次。拿到令牌就直接存进钥匙串并解除登出标记——令牌不经过前端，
/// 界面没有任何需要它的地方。
pub async fn device_poll(
    host: &str, client_id: &str, device_code: &str, attempt_id: &str,
) -> Result<PollStatus, String> {
    let kind = {
        let attempts = ATTEMPTS.lock().map_err(|_| "Account session lock unavailable")?;
        let attempt = attempts
            .get(host)
            .filter(|a| a.id == attempt_id && a.client == client_id && a.device_code.as_deref() == Some(device_code))
            .ok_or("Sign-in was cancelled or replaced")?;
        attempt.kind
    };
    let url = endpoint(host, kind, false)?;

    let v = post(
        &url,
        &[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )
    .await?;

    if v.get("access_token").is_some() {
        let credential = Credential::from_response(&v, kind, client_id, None)?;
        finish_attempt(host, attempt_id, || {
            settings::set_host_token(host, &credential.encode()?)?;
            settings::set_ignored(host, false)
        })?;
        return Ok(PollStatus::Done);
    }

    match v.get("error").and_then(|e| e.as_str()) {
        Some("authorization_pending") => Ok(PollStatus::Pending),
        Some("slow_down") => Ok(PollStatus::SlowDown),
        Some("access_denied") => Ok(PollStatus::Denied),
        Some("expired_token") => Ok(PollStatus::Expired),
        Some(other) => Err(describe(other, &v)),
        None => Err("授权服务器返回了看不懂的响应".into()),
    }
}

fn field(v: &serde_json::Value, key: &str) -> Result<String, String> {
    v.get(key).and_then(|s| s.as_str()).map(str::to_string).ok_or_else(|| format!("授权响应里没有 {key}"))
}

/// 原样带上服务端的说明——OAuth 的错误码只有和 error_description 合起来才有用。
/// 另外几种「光看错误码不知道该干什么」的，翻成人话。
fn describe(code: &str, v: &serde_json::Value) -> String {
    let hint = match code {
        // GitHub 的应用默认不开设备码，得去应用设置里勾 Enable Device Flow
        "device_flow_disabled" => Some("这个应用没开启设备码登录，去应用设置里勾上 Enable Device Flow"),
        // client_id 不对时 GitHub 回 404，GitLab 回 invalid_client
        "Not Found" | "not_found" | "invalid_client" => Some("应用 ID 不对，或者这个应用不在当前实例上"),
        "unauthorized_client" => Some("这个应用不允许用设备码登录"),
        _ => None,
    };
    match (v.get("error_description").and_then(|d| d.as_str()), hint) {
        (Some(d), _) => format!("{code}: {d}"),
        (None, Some(h)) => format!("{code}——{h}"),
        (None, None) => code.to_string(),
    }
}

async fn post(url: &str, form: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let res = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?
        .post(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        // GitHub 默认回 form-urlencoded，显式要 JSON 才好解析
        .header(reqwest::header::ACCEPT, "application/json")
        .form(form)
        .send()
        .await
        .map_err(|e| format!("请求 {url} 失败: {e}"))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|_| {
        // 自建实例版本太老时 /oauth/authorize_device 会返回 HTML 404，
        // 直接把状态码报出来比抛 JSON 解析错误有用
        format!("{url} 返回了非 JSON 响应（HTTP {status}）——实例可能不支持设备码登录（GitLab 需要 17.1 以上）")
    })?;
    if !status.is_success() && value.get("error").is_none() {
        return Err(format!("OAuth request failed (HTTP {status})"));
    }
    Ok(value)
}

const PREFIX: &str = "gitcub-oauth:";
/// 2026-10-30 改名前写入的凭据前缀，解码时继续认；编码只用 PREFIX
pub(crate) const LEGACY_PREFIX: &str = "quipu-oauth:";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
    kind: Kind,
    client_id: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    // Stable identity for consumers holding a token snapshot across renewals.
    session_token: String,
    #[serde(default)]
    previous_tokens: Vec<String>,
}
fn now_seconds() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}
impl Credential {
    fn from_response(
        value: &serde_json::Value, kind: Kind, client: &str, previous: Option<&Self>,
    ) -> Result<Self, String> {
        let valid = |value: &serde_json::Value| {
            value
                .as_str()
                .filter(|token| !token.is_empty() && !token.chars().any(char::is_whitespace))
                .map(str::to_owned)
        };
        let access_token = valid(&value["access_token"]).ok_or("Invalid OAuth access token")?;
        let refresh_token = match value.get("refresh_token") {
            Some(value) => Some(valid(value).ok_or("Invalid OAuth refresh token")?),
            None => previous.and_then(|old| old.refresh_token.clone()),
        };
        let expires_at = value
            .get("expires_in")
            .map(|value| {
                value.as_u64().and_then(|seconds| now_seconds().checked_add(seconds)).ok_or("Invalid OAuth expiry")
            })
            .transpose()?;
        let mut previous_tokens = previous.map(|old| old.previous_tokens.clone()).unwrap_or_default();
        if let Some(old) = previous {
            previous_tokens.push(old.access_token.clone());
            if let Some(token) = &old.refresh_token {
                previous_tokens.push(token.clone());
            }
            if previous_tokens.len() > 16 {
                previous_tokens.drain(..previous_tokens.len() - 16);
            }
        }
        Ok(Self {
            previous_tokens,
            kind,
            client_id: client.into(),
            session_token: previous.map(|old| old.session_token.clone()).unwrap_or_else(|| access_token.clone()),
            access_token,
            refresh_token,
            expires_at,
        })
    }
    fn encode(&self) -> Result<String, String> {
        serde_json::to_string(self)
            .map(|json| format!("{PREFIX}{json}"))
            .map_err(|_| "Unable to serialize credentials".into())
    }
}
fn decode(value: &str) -> Result<Option<Credential>, String> {
    value
        .strip_prefix(PREFIX)
        .or_else(|| value.strip_prefix(LEGACY_PREFIX))
        .map(|json| {
            serde_json::from_str(json).map_err(|_| "Stored OAuth credentials are invalid; sign in again".into())
        })
        .transpose()
}
#[cfg(test)]
pub fn session_token(value: &str) -> Result<Option<String>, String> {
    Ok(decode(value)?.map(|credential| credential.session_token))
}
pub fn access_token(value: &str) -> Option<String> {
    decode(value).ok().flatten().map(|credential| credential.access_token)
}
/// 登录时选过的平台：自建实例验证账号时只问这一家，不再拿另一家的错误混进来。
/// 从 GitHub Desktop 导入的凭据（`github-desktop-oauth:`，见 settings::access_token）只可能是 GitHub。
pub fn kind(value: &str) -> Option<Kind> {
    if value.starts_with("github-desktop-oauth:") {
        return Some(Kind::Github);
    }
    decode(value).ok().flatten().map(|credential| credential.kind)
}
static REFRESH: LazyLock<Mutex<HashMap<String, std::sync::Arc<tauri::async_runtime::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Serialize rotating-token exchanges; retain credentials on transient failures.
pub async fn refresh(host: &str) -> Result<(), String> {
    refresh_inner(host, None).await
}
async fn refresh_inner(host: &str, expected_refresh: Option<&str>) -> Result<(), String> {
    let lock = REFRESH.lock().map_err(|_| "Account refresh lock unavailable")?.entry(host.into()).or_default().clone();
    let _refresh = lock.lock().await;
    if settings::is_ignored(host) {
        return Ok(());
    }
    let Some(stored) = settings::stored_credential(host) else {
        return Ok(());
    };
    let Some(credential) = decode(&stored)? else {
        return Ok(());
    };
    if let Some(expected) = expected_refresh
        && credential.refresh_token.as_deref() != Some(expected)
    {
        if credential.previous_tokens.iter().any(|token| token == expected) {
            return Ok(());
        }
        return Err("The account has been replaced".into());
    }
    if expected_refresh.is_none() && credential.expires_at.is_none_or(|expiry| expiry > now_seconds() + 60) {
        return Ok(());
    }
    let next = renew(&credential, &endpoint(host, credential.kind, false)?).await?;
    // Compare under the same lock used by explicit sign-in/out. A replaced account wins.
    let _attempts = ATTEMPTS.lock().map_err(|_| "Account session lock unavailable")?;
    if settings::is_ignored(host) || settings::stored_credential(host).as_deref() != Some(stored.as_str()) {
        return Err("Account changed while renewing credentials".into());
    }
    settings::set_host_token(host, &next.encode()?)
}
pub async fn resolve_token(host: &str, token: &str) -> Result<Option<String>, String> {
    refresh(host).await?;
    if settings::is_ignored(host) {
        return Err("The account has signed out".into());
    }
    let Some(value) = settings::stored_credential(host) else {
        return Ok(None);
    };
    let Some(credential) = decode(&value)? else {
        // Legacy Desktop rotating sessions resolve their own token aliases.
        // Plain PATs have no aliases: a stale account must not keep using the
        // previous PAT after the user replaces it in native account settings.
        if !value.starts_with("github-desktop-oauth:") {
            return if value == token {
                Ok(Some(value))
            } else {
                Err("The account has been replaced; sign in again".into())
            };
        }
        return Ok(None);
    };
    if token != credential.session_token
        && token != credential.access_token
        && !credential.previous_tokens.iter().any(|previous| previous == token)
    {
        return Err("The account has been replaced; sign in again".into());
    }
    Ok(Some(credential.access_token))
}

fn desktop_credential(credential: &Credential) -> serde_json::Value {
    let mut value = serde_json::json!({"accessToken":credential.access_token});
    if let Some(token) = &credential.refresh_token {
        value["refreshToken"] = token.clone().into();
    }
    if let Some(expiry) = credential.expires_at {
        value["expiresAt"] = expiry.saturating_mul(1000).into();
    }
    value
}
pub fn desktop_storage(value: &str) -> Result<Option<String>, String> {
    Ok(decode(value)?.map(|credential| {
        if credential.refresh_token.is_none() {
            credential.access_token.clone()
        } else {
            format!(
                "github-desktop-oauth:{}",
                serde_json::json!({"version":1,"credential":desktop_credential(&credential)})
            )
        }
    }))
}
pub async fn renew_for_desktop(host: &str, refresh_token: &str) -> Result<Option<serde_json::Value>, String> {
    let Some(stored) = settings::stored_credential(host) else {
        return Ok(None);
    };
    if decode(&stored)?.is_none() {
        return Ok(None);
    }
    if settings::is_ignored(host) {
        return Err("The account has signed out".into());
    }
    refresh_inner(host, Some(refresh_token)).await?;
    let stored = settings::stored_credential(host).ok_or("The account has signed out")?;
    let credential = decode(&stored)?.ok_or("The account has been replaced")?;
    if credential.refresh_token.as_deref() != Some(refresh_token)
        && !credential.previous_tokens.iter().any(|previous| previous == refresh_token)
    {
        return Err("The account has been replaced".into());
    }
    Ok(Some(desktop_credential(&credential)))
}

async fn renew(credential: &Credential, url: &str) -> Result<Credential, String> {
    let refresh_token = credential.refresh_token.as_deref().ok_or("The account token expired; sign in again")?;
    let response = post(
        url,
        &[
            ("client_id", credential.client_id.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ],
    )
    .await?;
    if let Some(error) = response["error"].as_str() {
        return Err(describe(error, &response));
    }
    let next = Credential::from_response(&response, credential.kind, &credential.client_id, Some(credential))?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn attempt(host: &str, id: &str) {
        ATTEMPTS.lock().unwrap().insert(
            host.into(),
            Attempt { id: id.into(), client: "client".into(), kind: Kind::Gitlab, device_code: Some("device".into()) },
        );
    }
    #[test]
    fn enterprise_routes_and_gitlab_write_permissions() {
        assert!(provider("enterprise.test", None).is_err());
        assert_eq!(
            endpoint("enterprise.test:8443", Kind::Github, true).unwrap(),
            "https://enterprise.test:8443/login/device/code"
        );
        assert_eq!(endpoint("gitlab.test", Kind::Gitlab, false).unwrap(), "https://gitlab.test/oauth/token");
        assert!(scope(Kind::Gitlab).split_whitespace().any(|scope| scope == "api"));
        for required in ["repo", "read:org", "user:email", "workflow", "notifications"] {
            assert!(scope(Kind::Github).split_whitespace().any(|scope| scope == required));
        }
        for host in ["user:password@host.test", "host.test/path", "host.test?query", "host.test#fragment"] {
            assert!(endpoint(host, Kind::Github, true).is_err());
        }
    }
    #[test]
    fn gitlab_subpath_instances_keep_the_base_path() {
        assert_eq!(
            endpoint("gitlab.test/gitlab", Kind::Gitlab, true).unwrap(),
            "https://gitlab.test/gitlab/oauth/authorize_device"
        );
        assert_eq!(
            endpoint("gitlab.test:8443/tools/gitlab", Kind::Gitlab, false).unwrap(),
            "https://gitlab.test:8443/tools/gitlab/oauth/token"
        );
        for host in [
            "gitlab.test/gitlab/",
            "gitlab.test//gitlab",
            "gitlab.test/../evil",
            "gitlab.test/a/./b",
            "gitlab.test/gitlab?x=1",
            "gitlab.test/gitlab#x",
            "user@gitlab.test/gitlab",
        ] {
            assert!(endpoint(host, Kind::Gitlab, false).is_err(), "{host}");
        }
    }
    #[test]
    fn cancel_or_signout_prevents_an_in_flight_response_from_persisting() {
        for (host, logout) in [("cancel.example.invalid", false), ("logout.example.invalid", true)] {
            attempt(host, "first");
            if logout {
                change_account(host, || Ok(())).unwrap();
            } else {
                cancel(host, "first").unwrap();
            }
            let mut written = false;
            assert!(
                finish_attempt(host, "first", || {
                    written = true;
                    Ok(())
                })
                .is_err()
            );
            assert!(!written);
        }
    }
    /// 从 Desktop 导入的凭据没有本应用的平台标记，但前缀本身已说明是 GitHub。
    #[test]
    fn desktop_imported_credentials_are_github() {
        assert_eq!(kind(r#"github-desktop-oauth:{"access_token":"t"}"#), Some(Kind::Github));
        assert_eq!(kind("plain-pat"), None);
        assert_eq!(kind("gitcub-oauth:invalid"), None);
    }
    #[test]
    fn an_old_response_and_old_cancel_cannot_replace_the_next_signin() {
        let host = "replace.example.invalid";
        attempt(host, "first");
        attempt(host, "second");
        cancel(host, "first").unwrap();
        assert!(finish_attempt::<()>(host, "first", || panic!("old response persisted")).is_err());
        let mut saved = false;
        finish_attempt(host, "second", || {
            saved = true;
            Ok(())
        })
        .unwrap();
        assert!(saved);
        assert!(finish_attempt(host, "second", || Ok(())).is_err());
    }
    #[test]
    fn invalid_expiry_and_tokens_never_become_credentials() {
        for response in [
            json!({"access_token":""}),
            json!({"access_token":"white space"}),
            json!({"access_token":"access", "expires_in":-1}),
            json!({"access_token":"access", "refresh_token":""}),
        ] {
            assert!(Credential::from_response(&response, Kind::Gitlab, "client", None).is_err());
        }
        assert!(session_token("gitcub-oauth:invalid").is_err());
    }
    #[test]
    fn rotating_pair_survives_roundtrip_and_keeps_session_identity() {
        let first = Credential::from_response(
            &json!({"access_token":"old", "refresh_token":"refresh-old", "expires_in":0}),
            Kind::Gitlab,
            "client",
            None,
        )
        .unwrap();
        let first = decode(&first.encode().unwrap()).unwrap().unwrap();
        let second = Credential::from_response(
            &json!({"access_token":"new", "refresh_token":"refresh-new", "expires_in":3600}),
            Kind::Gitlab,
            "client",
            Some(&first),
        )
        .unwrap();
        assert_eq!(second.session_token, "old");
        assert_eq!(second.refresh_token.as_deref(), Some("refresh-new"));
        assert_eq!(access_token(&second.encode().unwrap()).as_deref(), Some("new"));
        assert_eq!(session_token(&second.encode().unwrap()).unwrap().as_deref(), Some("old"));
    }
    #[test]
    fn actual_refresh_request_uses_the_registered_client_and_rotates_both_tokens() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/oauth/token", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut data = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = connection.read(&mut buffer).unwrap();
                assert!(count > 0);
                data.extend_from_slice(&buffer[..count]);
                if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&data[..end]);
                    let length: usize = header
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    if data.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8(data).unwrap();
            assert!(request.contains("grant_type=refresh_token"));
            assert!(request.contains("client_id=registered-client"));
            assert!(request.contains("refresh_token=refresh-old"));
            let body = r#"{"access_token":"new","refresh_token":"refresh-new","expires_in":7200}"#;
            write!(connection, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let original = Credential::from_response(
            &json!({"access_token":"old", "refresh_token":"refresh-old", "expires_in":0}),
            Kind::Gitlab,
            "registered-client",
            None,
        )
        .unwrap();
        let refreshed = tauri::async_runtime::block_on(renew(&original, &url)).unwrap();
        server.join().unwrap();
        assert_eq!(refreshed.access_token, "new");
        assert_eq!(refreshed.refresh_token.as_deref(), Some("refresh-new"));
        assert_eq!(refreshed.session_token, "old");
    }
}
