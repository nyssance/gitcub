use tauri_plugin_window_decorations::WebviewWindowExt;

pub async fn activate(window: tauri::WebviewWindow) {
    if let Err(error) = window.activate_decoration().await {
        log::error!("Activate main window decoration: {error}");
        if let Err(restore_error) = window.restore_decoration().await {
            log::error!("Restore main window decoration: {restore_error}");
        }
    }
}
