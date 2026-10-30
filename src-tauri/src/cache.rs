//! 网络结果的磁盘缓存。
//!
//! 趋势榜、我的仓库、星标、账号信息这些每次开页都重拉一遍没道理——同一份东西
//! 几分钟内不会变，而每次都等一个网络往返，页面就每次都先白一下。
//!
//! 两条原则：
//!   1. 放系统缓存目录（`app_cache_dir`），不放配置目录。它是可再生的，
//!      用户清缓存就该能清掉，不该跟着配置一起被备份、同步。
//!   2. 过期不等于没用：拉失败时回退到旧数据，离线看旧榜单也好过一片空白。

use serde::{Serialize, de::DeserializeOwned};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

type FetchLocks = HashMap<std::path::PathBuf, Arc<tauri::async_runtime::Mutex<()>>>;
static FETCH_LOCKS: LazyLock<Mutex<FetchLocks>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize, serde::Deserialize)]
struct Entry<T> {
    /// Unix 秒
    fetched_at: u64,
    value: T,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// 文件名要能当路径用：host 里有点、URL 里有斜杠，统统换掉
fn path(app: &tauri::AppHandle, key: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_cache_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let safe: String =
        key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    Some(dir.join(format!("{safe}.json")))
}

/// 读缓存，连同「是不是已经过期」一起给。调用方自己决定过期了要不要用。
pub fn read<T: DeserializeOwned>(app: &tauri::AppHandle, key: &str, ttl: Duration) -> Option<(T, bool)> {
    let p = path(app, key)?;
    let text = std::fs::read_to_string(p).ok()?;
    let entry: Entry<T> = serde_json::from_str(&text).ok()?;
    let stale = ttl.is_zero() || now().saturating_sub(entry.fetched_at) > ttl.as_secs();
    Some((entry.value, stale))
}

pub fn write<T: Serialize>(app: &tauri::AppHandle, key: &str, value: &T) {
    let Some(p) = path(app, key) else { return };
    let entry = Entry { fetched_at: now(), value };
    match serde_json::to_string(&entry) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&p, text) {
                log::warn!("写缓存 {} 失败: {e}", p.display());
            }
        }
        Err(e) => log::warn!("序列化缓存 {key} 失败: {e}"),
    }
}

/// Credentials changed during import: do not keep the previous signed-out result.
pub fn invalidate(app: &tauri::AppHandle, key: &str) {
    if let Some(path) = path(app, key)
        && let Err(error) = std::fs::remove_file(path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        log::warn!("Unable to invalidate cache {key}: {error}");
    }
}

/// 缓存新鲜就直接用；过期或没有就去拉，拉成功写回，**拉失败回退到旧数据**。
/// `refresh` 为真时跳过新鲜度检查，强制去拉且失败必须返回错误（界面上的刷新按钮走这条）。
pub async fn get_or_fetch<T, F, Fut>(
    app: &tauri::AppHandle, key: &str, ttl: Duration, refresh: bool, fetch: F,
) -> Result<T, String>
where
    T: Serialize + DeserializeOwned,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    // Concurrent renders share one cache fill instead of starting the same paginated request again.
    let lock = path(app, key).map(|path| {
        FETCH_LOCKS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).entry(path).or_default().clone()
    });
    let _guard = match &lock {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };
    let cached = read::<T>(app, key, ttl);
    if !refresh && let Some((value, false)) = cached {
        return Ok(value);
    }
    let stale = cached.map(|(v, _)| v);

    match fetch().await {
        Ok(value) => {
            write(app, key, &value);
            Ok(value)
        }
        Err(e) if refresh => Err(e),
        Err(e) => match stale {
            Some(value) => {
                log::warn!("{key} 拉取失败（{e}），用缓存里的旧数据");
                Ok(value)
            }
            None => Err(e),
        },
    }
}
