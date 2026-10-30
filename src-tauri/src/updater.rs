//! Signed Tauri updates, with Desktop's download/quit lifecycle.
use serde::Serialize;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, Manager, State, ipc::Channel};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState {
    busy: AtomicBool,
    downloading: AtomicBool,
    installing: AtomicBool,
    allow_exit: AtomicBool,
    downloaded: Mutex<Option<(Update, Vec<u8>)>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpdateEvent {
    Checking,
    NotAvailable,
    Available { version: String, notes: Option<String> },
    Downloaded,
    Error { message: String },
}

pub fn endpoint() -> Option<String> {
    #[cfg(feature = "hasgard-testing")]
    if let Ok(endpoint) = std::env::var("GITCUB_TEST_UPDATE_ENDPOINT") {
        return Some(endpoint);
    }
    option_env!("GITCUB_UPDATE_ENDPOINT").map(str::to_owned)
}

pub fn should_delay_exit(app: &AppHandle) -> bool {
    let state = app.state::<UpdateState>();
    if (state.downloading.load(Ordering::SeqCst) || state.installing.load(Ordering::SeqCst))
        && !state.allow_exit.load(Ordering::SeqCst)
    {
        let _ = app.emit("show-installing-update", ());
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn updater_endpoint() -> Option<String> {
    endpoint()
}

#[tauri::command]
pub async fn updater_check(app: AppHandle, events: Channel<UpdateEvent>) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = check_and_download(&app, &events).await;
    state.busy.store(false, Ordering::SeqCst);
    state.downloading.store(false, Ordering::SeqCst);
    if let Err(message) = &result {
        let _ = events.send(UpdateEvent::Error { message: message.clone() });
    }
    result
}

async fn check_and_download(app: &AppHandle, events: &Channel<UpdateEvent>) -> Result<(), String> {
    let endpoint = endpoint().ok_or("This build has no update endpoint configured")?;
    let url: reqwest::Url = endpoint.parse().map_err(|e| format!("Invalid update endpoint: {e}"))?;
    if url.scheme() != "https" {
        #[cfg(feature = "hasgard-testing")]
        let local_test = url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
        #[cfg(not(feature = "hasgard-testing"))]
        let local_test = false;
        if !local_test {
            return Err("Update endpoints must use HTTPS".into());
        }
    }
    let _ = events.send(UpdateEvent::Checking);
    let mut builder = app.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?;
    if let Some(key) = option_env!("GITCUB_UPDATE_PUBLIC_KEY") {
        builder = builder.pubkey(key);
    }
    #[cfg(feature = "hasgard-testing")]
    if let Ok(key) = std::env::var("GITCUB_TEST_UPDATE_PUBLIC_KEY") {
        builder = builder.pubkey(key);
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        let _ = events.send(UpdateEvent::NotAvailable);
        return Ok(());
    };
    let state = app.state::<UpdateState>();
    state.downloading.store(true, Ordering::SeqCst);
    let _ = events.send(UpdateEvent::Available { version: update.version.clone(), notes: update.body.clone() });
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    *state.downloaded.lock().map_err(|e| e.to_string())? = Some((update, bytes));
    let _ = events.send(UpdateEvent::Downloaded);
    Ok(())
}

#[tauri::command]
pub fn request_quit(app: AppHandle, force: bool) {
    if force {
        app.state::<UpdateState>().allow_exit.store(true, Ordering::SeqCst);
    }
    if !should_delay_exit(&app) {
        app.exit(0);
    }
}

#[tauri::command]
pub fn cancel_quit(state: State<'_, UpdateState>) {
    state.allow_exit.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("An update is already being installed".into());
    }
    let downloaded = state.downloaded.lock().map_err(|e| e.to_string())?.clone();
    let Some((update, bytes)) = downloaded else {
        state.installing.store(false, Ordering::SeqCst);
        return Err("No verified update is ready".into());
    };
    let result = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result.map_err(|e| e.to_string()));
    if let Err(error) = result {
        state.installing.store(false, Ordering::SeqCst);
        return Err(error);
    }
    state.allow_exit.store(true, Ordering::SeqCst);
    app.restart();
}
