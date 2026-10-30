//! 命名 KV 存储的桌面侧入口（`@alwith/module-store` 的 Tauri 实现），照搬 ALwith Desktop
//! `features/store.rs`，去掉其 provider 专属过滤；crate 与 ALwith Desktop 共用 crates.io 的 alwith-module-store。
//!
//! 前端的 Desktop 数据库（仓库、用户、Issue、PR、统计）原先放在 WebView 的 IndexedDB（Dexie）里，
//! 不随应用数据备份、各平台落盘位置也不一致；用户于 2026-10-26 决定去掉 Dexie，改走这里。
//! 每个 store 名对应一个 json 文件，复用 alwith-module-store 的单写者实现（原子替换 + `.bak` +
//! 损坏不静默重置），变更经 `store-changed` 事件广播。
//!
//! 文件读写都是阻塞操作，所有命令经 `spawn_blocking` 离开主线程；写入顺序由前端按库串行。

use alwith_module_store::{ScopedStores, Store, StoreScope};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

pub struct NamedStoreState {
    stores: ScopedStores,
}

impl NamedStoreState {
    pub fn store_in(&self, scope: StoreScope, name: &str) -> Result<std::sync::Arc<Store>, String> {
        self.stores.open(scope, name)
    }
}

/// 缓存域 store 的子目录名 —— 单独一层，清缓存时整个删掉即可。
pub const CACHE_STORE_DIRECTORY: &str = "stores";

/// 2026-10-30 存储名从 quipu-* 改成 gitcub-*：老文件原地改名一次，新文件已存在就不动旧的。
fn migrate_renamed_stores(data_directory: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(data_directory) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix("quipu-") else { continue };
        let target = data_directory.join(format!("gitcub-{rest}"));
        if target.exists() {
            continue;
        }
        if let Err(error) = std::fs::rename(entry.path(), &target) {
            log::warn!("迁移存储文件 {name} 失败: {error}");
        }
    }
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    let data_directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let cache_directory = app.path().app_cache_dir().map_err(|error| error.to_string())?.join(CACHE_STORE_DIRECTORY);
    std::fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&cache_directory).map_err(|error| error.to_string())?;
    migrate_renamed_stores(&data_directory);
    let state = NamedStoreState { stores: ScopedStores::new(data_directory, cache_directory) };
    // 所有命名存储的变更走同一条通道，订阅一次即可 —— 不是每开一个 store 各挂一个转发任务。
    let (mut receiver, mut cache_receiver) = state.stores.subscribe();
    let emit_application = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let change = tokio::select! {
                data = receiver.recv() => data,
                cache = cache_receiver.recv() => cache
            };
            match change {
                Ok(change) => {
                    let _ = emit_application.emit("store-changed", &change);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    app.manage(state);
    Ok(())
}

fn open(app: &AppHandle, scope: StoreScope, store: &str) -> Result<std::sync::Arc<Store>, String> {
    app.state::<NamedStoreState>().store_in(scope, store)
}

async fn blocking<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn store_entries(app: AppHandle, scope: StoreScope, store: String) -> Result<Value, String> {
    let store = open(&app, scope, &store)?;
    blocking(move || Ok(Value::Object(store.entries().into_iter().collect()))).await
}

#[tauri::command]
pub async fn store_set(
    app: AppHandle, scope: StoreScope, store: String, key: String, value: Value,
) -> Result<(), String> {
    let store = open(&app, scope, &store)?;
    blocking(move || store.set(key, value)).await
}

#[tauri::command]
pub async fn store_delete(app: AppHandle, scope: StoreScope, store: String, key: String) -> Result<(), String> {
    let store = open(&app, scope, &store)?;
    blocking(move || store.remove(&key)).await
}

#[tauri::command]
pub async fn store_clear(app: AppHandle, scope: StoreScope, store: String) -> Result<(), String> {
    let store = open(&app, scope, &store)?;
    blocking(move || store.clear()).await
}

#[tauri::command]
pub async fn store_reload(app: AppHandle, scope: StoreScope, store: String) -> Result<(), String> {
    let store = open(&app, scope, &store)?;
    blocking(move || store.reload()).await
}
