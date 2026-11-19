//! 设置：账户 token、Git 身份、外观与语言。
//!
//! token 走系统钥匙串（macOS Keychain / Windows Credential Manager），
//! **不进配置文件**。明文存 token 是把长期凭据写到一个
//! 备份工具和同步盘都会顺手带走的地方。

use crate::credentials;
use crate::remote;
use serde::Serialize;
use std::path::Path;

const SERVICE: &str = "day.dreamer.gitcub";

/// 令牌按**主机名**存在钥匙串里（account = github.com / 自建实例域名 …）。
/// 不写死 GitHub / GitLab 两家：自建实例才是很多人的主力，它们的域名各不相同。
#[cfg(not(debug_assertions))]
fn entry(host: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, host).map_err(|e| format!("打开钥匙串失败: {e}"))
}

/// 写之前先删：macOS 的钥匙串对已存在的条目直接回 errSecDuplicateItem
/// （实测「保存失败: Platform failure: The specified item already exists」），
/// 于是第二次保存同一个 host 的令牌必然失败。
/// 开发构建完全不碰系统钥匙串。
///
/// macOS 的钥匙串 ACL 认调用方的代码签名，而 `cargo run` 的二进制是 ad-hoc
/// 签名、每次重编身份都变，于是**每次读写都弹窗问登录密码**——一天下来能弹
/// 几十次。之前只让读失败时回退到文件，写还在往钥匙串塞，等于没治。
/// 发布版有稳定的 Developer ID 签名，照常走钥匙串。
#[cfg(debug_assertions)]
fn put(key: &str, value: &str) -> Result<(), String> {
    dev_write(key, value)
}

#[cfg(not(debug_assertions))]
fn put(key: &str, value: &str) -> Result<(), String> {
    let e = entry(key)?;
    clear(&e)?;
    e.set_password(value).map_err(|e| format!("保存失败: {e}"))
}

#[cfg(not(debug_assertions))]
fn clear(e: &keyring::Entry) -> Result<(), String> {
    match e.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("清除失败: {err}")),
    }
}

/// 按键名清除（连开发期回退一起）
#[cfg(debug_assertions)]
fn clear_key(key: &str) -> Result<(), String> {
    dev_clear(key)
}

#[cfg(not(debug_assertions))]
fn clear_key(key: &str) -> Result<(), String> {
    clear(&entry(key)?)
}

pub fn set_host_token(host: &str, token: &str) -> Result<(), String> {
    // 空值表示清除
    if token.is_empty() {
        return clear_key(host);
    }
    put(host, token)
}

/// The secure item is shared by native Git and Desktop's rotating sessions.
pub fn stored_credential(host: &str) -> Option<String> {
    read(host)
}

pub(crate) fn profile_key(host: &str, login: &str) -> String {
    // Bound both the Keychain item name and the development filename for long instance paths.
    let mut hash = gix::hash::hasher(gix::hash::Kind::Sha256);
    hash.update(host.as_bytes());
    hash.update(&[0]);
    hash.update(login.to_ascii_lowercase().as_bytes());
    format!("/accounts/{}", hash.try_finalize().expect("SHA-256 is enabled"))
}

pub fn save_profile(host: &str, login: &str, token: &str) -> Result<(), String> {
    set_host_token(&profile_key(host, login), token)
}

pub async fn profile_token(host: String, login: String) -> Result<String, String> {
    let key = profile_key(&host, &login);
    crate::oauth::refresh_profile(&host, &key).await?;
    tauri::async_runtime::spawn_blocking(move || {
        read(&key).and_then(|value| access_token(&value)).ok_or_else(|| format!("Sign in as {login} on {host}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

pub fn access_token(value: &str) -> Option<String> {
    if value.starts_with(crate::oauth::PREFIX) {
        return crate::oauth::access_token(value);
    }
    if let Some(json) = value.strip_prefix("github-desktop-oauth:") {
        let record: serde_json::Value = serde_json::from_str(json).ok()?;
        if record["version"] != 1 {
            return None;
        }
        record["credential"]["accessToken"].as_str().filter(|s| !s.is_empty()).map(str::to_owned)
    } else {
        (!value.is_empty()).then(|| value.to_owned())
    }
}

/// 读不到分两种：没存过（正常）和真出错（钥匙串权限被拒之类）。
/// 后者要留痕，否则表现成「明明存了却当没存」，没法查。
/// 同 put：开发构建只读文件，不碰钥匙串
#[cfg(debug_assertions)]
fn read(key: &str) -> Option<String> {
    dev_read(key)
}

#[cfg(not(debug_assertions))]
fn read(key: &str) -> Option<String> {
    let entry = match entry(key) {
        Ok(entry) => entry,
        Err(error) => {
            log::warn!("读钥匙串 {key} 失败: {error}");
            return None;
        }
    };
    match entry.get_password() {
        Ok(v) => Some(v),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            log::warn!("读钥匙串 {key} 失败: {e}");
            None
        }
    }
}

/// 开发期的回退存储。
///
/// macOS 的钥匙串 ACL 认的是**调用方的代码签名**。`cargo run` 出来的二进制是
/// ad-hoc 签名，每次编译身份都变，于是自己写进去的条目自己都读不回来
/// （实测报 errSecAuthFailed：「The user name or passphrase you entered is not
/// correct」，而同一条用 /usr/bin/security 能读出来）。正式版有稳定的
/// Developer ID 签名，不存在这个问题。
///
/// 所以只在 debug 构建里留一份回退，放应用数据目录、权限 0600。这是明知的
/// 折中：开发机上的明文令牌换开发期能用。发布版永远只走钥匙串。
#[cfg(debug_assertions)]
fn dev_token_path(key: &str) -> Option<std::path::PathBuf> {
    // 各系统放数据的地方不一样。写死 macOS 那条路径的话，
    // Windows 上的开发构建会一声不响地存不下令牌
    let base: std::path::PathBuf = if cfg!(target_os = "macos") {
        std::path::Path::new(&std::env::var_os("HOME")?).join("Library/Application Support")
    } else {
        std::env::var_os("APPDATA")?.into()
    };
    #[cfg(feature = "hasgard-testing")]
    let base = std::env::var_os("GITCUB_TEST_DATA_DIR").map(std::path::PathBuf::from).unwrap_or(base);
    let dir = base.join(SERVICE).join("dev-tokens");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(dev_token_file(key)))
}

/// 旧键（`host[:port]`）的文件名保持不变；带子路径的实例键改用十六进制，
/// 免得 `git.example/gitlab` 与主机 `git.example.gitlab` 落到同一个文件、拿到别的实例的令牌。
#[cfg(debug_assertions)]
fn dev_token_file(key: &str) -> String {
    if key.contains('/') {
        return format!("instance-{}", key.bytes().map(|byte| format!("{byte:02x}")).collect::<String>());
    }
    key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

#[cfg(all(test, debug_assertions))]
mod tests {
    #[cfg(feature = "hasgard-testing")]
    #[test]
    fn scoped_credentials_survive_restart_and_individual_sign_out() {
        const PHASE: &str = "GITCUB_PROFILE_TEST_PHASE";
        let host = "profiles.invalid";
        let token = |login| super::read(&super::profile_key(host, login));
        match std::env::var(PHASE).as_deref() {
            Ok("save") => {
                super::save_profile(host, "Alice", "fixture-a").unwrap();
                super::save_profile(host, "Bob", "fixture-b").unwrap();
            }
            Ok("remove") => {
                assert_eq!(token("alice").as_deref(), Some("fixture-a"));
                assert_eq!(token("bob").as_deref(), Some("fixture-b"));
                super::save_profile(host, "ALICE", "").unwrap();
            }
            Ok("verify") => {
                assert_eq!(token("alice"), None);
                assert_eq!(token("bob").as_deref(), Some("fixture-b"));
                assert_eq!(super::stored_credential(host), None);
            }
            _ => {
                let directory = tempfile::tempdir().unwrap();
                for phase in ["save", "remove", "verify"] {
                    let result = std::process::Command::new(std::env::current_exe().unwrap())
                        .args([
                            "--exact",
                            "settings::tests::scoped_credentials_survive_restart_and_individual_sign_out",
                        ])
                        .env("GITCUB_TEST_DATA_DIR", directory.path())
                        .env(PHASE, phase)
                        .output()
                        .unwrap();
                    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stdout));
                }
            }
        }
    }

    #[test]
    fn repository_accounts_isolate_users_ports_and_instance_paths() {
        use super::{dev_token_file, profile_key, validate_destinations};
        use crate::branch::RepositoryAccount;
        let profile = RepositoryAccount { primary: false, host: "git.example:8443/team".into(), login: "Alice".into() };
        let key = |host: &str, login: &str| dev_token_file(&profile_key(host, login));
        assert_eq!(key(&profile.host, "Alice"), key(&profile.host, "alice"));
        assert_ne!(key(&profile.host, "alice"), key(&profile.host, "bob"));
        assert_ne!(key(&profile.host, "alice"), key("git.example/team", "alice"));
        assert!(key(&format!("git.example/{}", "tenant".repeat(35)), &"user".repeat(20)).len() < 255);
        let known = vec![profile.host.clone()];
        let check = |urls: &[&str]| {
            validate_destinations(&urls.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &known, Some(&profile))
        };
        assert_eq!(check(&["https://git.example:8443/team/group/project"]).unwrap(), Some(profile.host.clone()));
        assert!(check(&["https://git.example:8443/other/group/project"]).is_err());
        assert!(check(&["https://git.example/team/group/project"]).is_err());
        assert!(check(&["http://git.example:8443/team/group/project"]).is_err());
        assert!(check(&["https://git.example:8443/team/group/project", "https://elsewhere.invalid/a/b"]).is_err());
    }

    #[test]
    fn 子路径实例的开发期令牌文件不与其他主机重名() {
        assert_eq!(super::dev_token_file("git.example:8443"), "git_example_8443");
        assert_eq!(super::dev_token_file("git.example:8443!ignored"), "git_example_8443_ignored");
        let subpath = super::dev_token_file("git.example/gitlab");
        assert_ne!(subpath, super::dev_token_file("git.example.gitlab"));
        assert_ne!(subpath, super::dev_token_file("git.example/gitla"));
        assert_ne!(super::dev_token_file("git.example/gitlab!ignored"), subpath);
    }
}

#[cfg(debug_assertions)]
fn dev_read(key: &str) -> Option<String> {
    let path = dev_token_path(key)?;
    let v = read_dev_file(&path)?;
    let v = v.trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// 没存过是正常的；读失败（权限之类）要留痕，否则表现成「明明存了却当没存」。
#[cfg(debug_assertions)]
fn read_dev_file(path: &std::path::Path) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(v) => Some(v),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            log::warn!("读开发期令牌 {} 失败: {error}", path.display());
            None
        }
    }
}

#[cfg(debug_assertions)]
fn dev_write(key: &str, value: &str) -> Result<(), String> {
    use std::io::Write;
    let p = dev_token_path(key).ok_or("Unable to locate development credential storage")?;
    let mut file = tempfile::NamedTempFile::new_in(p.parent().ok_or("Invalid credential directory")?)
        .map_err(|error| format!("Unable to open development credential storage: {error}"))?;
    // NamedTempFile is mode 0600 on Unix; atomic replacement never exposes partial tokens.
    file.write_all(value.as_bytes()).map_err(|error| format!("Unable to save development credentials: {error}"))?;
    file.as_file().sync_all().map_err(|error| format!("Unable to flush development credentials: {error}"))?;
    file.persist(&p).map_err(|error| format!("Unable to replace development credentials: {error}"))?;
    Ok(())
}

#[cfg(debug_assertions)]
fn dev_clear(key: &str) -> Result<(), String> {
    let Some(p) = dev_token_path(key) else { return Ok(()) };
    match std::fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Unable to clear development credentials: {error}")),
    }
}

/// 「退出登录」不能只删自己存的令牌——凭据可能来自 gh / git 凭据助手，
/// 删完下一秒又被捡回来，看着就像没登出。所以登出是一个显式的「这个实例
/// 不再使用任何凭据」标记。
///
/// 标记也放钥匙串，不放 state.json：askpass 是 git 拉起的**独立进程**，
/// 那里读不到应用状态，但读得到钥匙串。
fn ignore_key(host: &str) -> String {
    format!("{host}!ignored")
}

pub fn set_ignored(host: &str, ignored: bool) -> Result<(), String> {
    if ignored {
        put(&ignore_key(host), "1")?;
    } else {
        clear_key(&ignore_key(host))?;
    }
    Ok(())
}

pub fn is_ignored(host: &str) -> bool {
    read(&ignore_key(host)).is_some()
}

/// Git 身份。`repo` 为 None 时读写全局配置。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

pub fn git_identity(repo: Option<&Path>) -> GitIdentity {
    GitIdentity {
        name: crate::git_config::get(repo, "user.name", false, false).ok().flatten().unwrap_or_default(),
        email: crate::git_config::get(repo, "user.email", false, false).ok().flatten().unwrap_or_default(),
    }
}

pub fn set_git_identity(repo: Option<&Path>, id: &GitIdentity) -> Result<(), String> {
    for (k, v) in [("user.name", &id.name), ("user.email", &id.email)] {
        crate::git_config::set(repo, k, v)?;
    }
    Ok(())
}

/// 该仓库该远端对应的 token，只读取 GitCub 已保存或一次导入的凭据。
pub async fn token_for(app: &tauri::AppHandle, repo: &Path, remote: &str) -> Result<Option<String>, String> {
    let path = repo.to_string_lossy().into_owned();
    let repo = repo.to_path_buf();
    let remote = remote.to_owned();
    let url = tauri::async_runtime::spawn_blocking(move || crate::remote_ops::get_url(&repo, &remote))
        .await
        .map_err(|error| error.to_string())?;
    let Some(url) = url? else {
        return Ok(None);
    };
    repository_token(app, &path, &[url]).await
}

pub async fn token_for_push(app: &tauri::AppHandle, repo: &Path, remote: &str) -> Result<Option<String>, String> {
    let path = repo.to_string_lossy().into_owned();
    let repo = repo.to_path_buf();
    let remote = remote.to_owned();
    let urls = tauri::async_runtime::spawn_blocking(move || crate::remote_ops::push_urls(&repo, &remote))
        .await
        .map_err(|error| error.to_string())??;
    repository_token(app, &path, &urls).await
}

async fn repository_token(app: &tauri::AppHandle, path: &str, urls: &[String]) -> Result<Option<String>, String> {
    let handle = app.clone();
    let path = path.to_owned();
    let (known, assigned) = tauri::async_runtime::spawn_blocking(move || {
        let assigned = crate::named_store::assigned_account(&handle, &path)?;
        Ok::<_, String>((crate::store::load(&handle)?.account_hosts, assigned))
    })
    .await
    .map_err(|error| error.to_string())??;
    let instance = validate_destinations(urls, &known, assigned.as_ref())?;
    if let Some(ref profile) = assigned
        && urls.iter().all(|url| url.starts_with("https://"))
    {
        return crate::account::repository_auth(&profile.host, profile).await.map(|(_, token)| Some(token));
    }
    if assigned.is_some() {
        return Ok(None);
    }
    token_for_instance(instance, &urls[0]).await
}

fn validate_destinations(
    urls: &[String], known: &[String], assigned: Option<&crate::branch::RepositoryAccount>,
) -> Result<Option<String>, String> {
    let first = credential_instance(urls.first().ok_or("Missing Git destination")?, known);
    if urls.iter().any(|url| credential_instance(url, known) != first) {
        return Err("Push destinations use different hosts; push to each remote separately".into());
    }
    if let Some(profile) = assigned {
        let https = urls.iter().filter(|url| url.starts_with("https://")).count();
        if https > 0 && (https != urls.len() || first.as_deref() != Some(&profile.host)) {
            return Err("The assigned account requires matching HTTPS destinations".into());
        }
        if urls.iter().any(|url| url.to_ascii_lowercase().starts_with("http://")) {
            return Err("The assigned account requires HTTPS".into());
        }
    }
    Ok(first)
}

/// 凭据按实例标识（`host[:port][/子路径]`）取：URL 落在哪个已知实例下就用哪个实例的令牌，
/// 同一主机上不同子路径的实例互不相通。
pub async fn token_for_url(app: &tauri::AppHandle, url: &str) -> Result<Option<String>, String> {
    let known = crate::store::known_instances(app).await?;
    token_for_instance(credential_instance(url, &known), url).await
}

fn credential_instance(url: &str, known: &[String]) -> Option<String> {
    remote::parse(url).map(|remote| remote::credential_instance(&remote, known))
}

async fn token_for_instance(instance: Option<String>, url: &str) -> Result<Option<String>, String> {
    let Some(host) = instance else {
        return Ok(None);
    };
    if is_ignored(&host) && url.starts_with("https://") {
        return Err(format!("Sign in to {host} before accessing this remote"));
    }
    crate::oauth::refresh(&host).await?;
    Ok(credentials::find_async(&host).await.map(|f| f.token))
}
