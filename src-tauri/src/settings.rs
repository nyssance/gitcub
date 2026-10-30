//! 设置：账户 token、Git 身份、外观与语言。
//!
//! token 走系统钥匙串（macOS Keychain / Windows Credential Manager /
//! Linux keyutils），**不进配置文件**。明文存 token 是把长期凭据写到一个
//! 备份工具和同步盘都会顺手带走的地方。

use crate::credentials;
use crate::remote;
use serde::Serialize;
use std::path::Path;

const SERVICE: &str = "day.dreamer.gitcub";
/// 2026-10-30 改名前的服务名；旧条目读得到，新写入只用 SERVICE
const LEGACY_SERVICE: &str = "com.yijoy.quipu";

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
    dev_clear(key);
    Ok(())
}

#[cfg(not(debug_assertions))]
fn clear_key(key: &str) -> Result<(), String> {
    dev_clear(key);
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

pub fn access_token(value: &str) -> Option<String> {
    if value.starts_with("gitcub-oauth:") || value.starts_with(crate::oauth::LEGACY_PREFIX) {
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
    match entry(key).ok()?.get_password() {
        Ok(v) => Some(v),
        Err(keyring::Error::NoEntry) => match keyring::Entry::new(LEGACY_SERVICE, key).ok()?.get_password() {
            Ok(v) => Some(v),
            Err(_) => None,
        },
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
    // Windows / Linux 上的开发构建会一声不响地存不下令牌
    let base: std::path::PathBuf = if cfg!(target_os = "macos") {
        std::path::Path::new(&std::env::var_os("HOME")?).join("Library/Application Support")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")?.into()
    } else {
        match std::env::var_os("XDG_DATA_HOME") {
            Some(x) if !x.is_empty() => x.into(),
            _ => std::path::Path::new(&std::env::var_os("HOME")?).join(".local/share"),
        }
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
    // 改名前的开发令牌目录：新目录没有就读旧目录
    let legacy = path.parent()?.parent()?.parent()?.join(LEGACY_SERVICE).join("dev-tokens").join(dev_token_file(key));
    let v = std::fs::read_to_string(&path).or_else(|_| std::fs::read_to_string(legacy)).ok()?;
    let v = v.trim().to_string();
    (!v.is_empty()).then_some(v)
}

#[cfg(not(debug_assertions))]
fn dev_read(_key: &str) -> Option<String> {
    None
}

#[cfg(debug_assertions)]
fn dev_write(key: &str, value: &str) -> Result<(), String> {
    use std::io::Write;
    let p = dev_token_path(key).ok_or("Unable to locate development credential storage")?;
    let mut file = tempfile::NamedTempFile::new_in(p.parent().ok_or("Invalid credential directory")?)
        .map_err(|_| "Unable to open development credential storage")?;
    // NamedTempFile is mode 0600 on Unix; atomic replacement never exposes partial tokens.
    file.write_all(value.as_bytes()).map_err(|_| "Unable to save development credentials")?;
    file.as_file().sync_all().map_err(|_| "Unable to flush development credentials")?;
    file.persist(&p).map_err(|_| "Unable to replace development credentials")?;
    Ok(())
}

#[cfg(not(debug_assertions))]
fn dev_write(_key: &str, _value: &str) {}

#[cfg(debug_assertions)]
fn dev_clear(key: &str) {
    if let Some(p) = dev_token_path(key) {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(not(debug_assertions))]
fn dev_clear(_key: &str) {}

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

/// 按远端 URL 猜是 GitHub 还是 GitLab。
/// 取某个远端的 URL，用来决定用哪份 token。
pub fn remote_url(repo: &Path, remote: &str) -> Option<String> {
    crate::remote_ops::get_url(repo, remote).ok().flatten()
}

/// 该仓库该远端对应的 token，只读取 GitCub 已保存或一次导入的凭据。
pub async fn token_for(app: &tauri::AppHandle, repo: &Path, remote: &str) -> Result<Option<String>, String> {
    let repo = repo.to_path_buf();
    let remote = remote.to_owned();
    let url = tauri::async_runtime::spawn_blocking(move || remote_url(&repo, &remote))
        .await
        .map_err(|error| error.to_string())?;
    let Some(url) = url else {
        return Ok(None);
    };
    token_for_url(app, &url).await
}

pub async fn token_for_push(app: &tauri::AppHandle, repo: &Path, remote: &str) -> Result<Option<String>, String> {
    let repo = repo.to_path_buf();
    let remote = remote.to_owned();
    let urls = tauri::async_runtime::spawn_blocking(move || crate::remote_ops::push_urls(&repo, &remote))
        .await
        .map_err(|error| error.to_string())??;
    let known = crate::store::known_instances(app).await;
    let first = credential_instance(&urls[0], &known);
    if urls.iter().any(|url| credential_instance(url, &known) != first) {
        return Err("Push destinations use different hosts; push to each remote separately".into());
    }
    token_for_instance(first, &urls[0]).await
}

/// 凭据按实例标识（`host[:port][/子路径]`）取：URL 落在哪个已知实例下就用哪个实例的令牌，
/// 同一主机上不同子路径的实例互不相通。
pub async fn token_for_url(app: &tauri::AppHandle, url: &str) -> Result<Option<String>, String> {
    let known = crate::store::known_instances(app).await;
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
