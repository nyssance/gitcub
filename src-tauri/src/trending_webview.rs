//! Public GitHub Trending page in a child webview. No scraping, API fallback or credentials.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    Manager,
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
};
use tauri_plugin_opener::OpenerExt;

const LABEL: &str = "github-trending";
const URL: &str = "https://github.com/trending";
static SESSION: Mutex<Option<String>> = Mutex::new(None);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserAction {
    State,
    Back,
    Forward,
    Stop,
    OpenExternal,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    url: String,
    can_go_back: bool,
    can_go_forward: bool,
}

#[tauri::command]
pub async fn control_trending_webview(
    caller: tauri::Webview, session: String, action: BrowserAction,
) -> Result<BrowserState, String> {
    if caller.label() != "main" {
        return Err("Only the main UI may control Trending".into());
    }
    let app = caller.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let current = SESSION.lock().map_err(|e| e.to_string())?;
        if current.as_deref() != Some(session.as_str()) {
            return Err("Trending session is no longer active".into());
        }
        let view = app.get_webview(LABEL).ok_or("Trending webview is not available")?;
        match action {
            BrowserAction::State => {}
            BrowserAction::Back => view.go_back().map_err(|e| e.to_string())?,
            BrowserAction::Forward => view.go_forward().map_err(|e| e.to_string())?,
            BrowserAction::Stop => view.eval("window.stop()").map_err(|e| e.to_string())?,
            BrowserAction::OpenExternal => {
                app.opener()
                    .open_url(view.url().map_err(|e| e.to_string())?, None::<&str>)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(BrowserState {
            url: view.url().map_err(|e| e.to_string())?.to_string(),
            can_go_back: view.can_go_back().map_err(|e| e.to_string())?,
            can_go_forward: view.can_go_forward().map_err(|e| e.to_string())?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
}

impl Frame {
    fn validate(&self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height].iter().any(|v| !v.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
        {
            return Err("Invalid webview bounds".into());
        }
        Ok(())
    }
    fn bounds(&self) -> tauri::Rect {
        tauri::Rect {
            position: tauri::LogicalPosition::new(self.x, self.y).into(),
            size: tauri::LogicalSize::new(self.width, self.height).into(),
        }
    }
}

fn is_github_page(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

fn open_link(app: &tauri::AppHandle, url: &tauri::Url) {
    if matches!(url.scheme(), "https" | "http") {
        let app = app.clone();
        let url = url.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = app.opener().open_url(url, None::<&str>) {
                log::warn!("Unable to open Trending link: {error}");
            }
        });
    }
}

#[tauri::command]
pub async fn sync_trending_webview(
    caller: tauri::Webview, session: String, frame: Option<Frame>, reload: bool,
    on_load: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<(), String> {
    if caller.label() != "main" {
        return Err("Only the main UI may control Trending".into());
    }
    let app = caller.app_handle().clone();
    let window = caller.window();
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = SESSION.lock().map_err(|e| e.to_string())?;
        let Some(frame) = frame else {
            if current.as_deref() == Some(session.as_str()) {
                if let Some(view) = app.get_webview(LABEL) {
                    view.close().map_err(|e| e.to_string())?;
                }
                *current = None;
            }
            return Ok(());
        };
        frame.validate()?;
        if current.as_deref() != Some(session.as_str()) {
            if let Some(view) = app.get_webview(LABEL) {
                view.close().map_err(|e| e.to_string())?;
            }
            *current = None;
        }
        if let Some(view) = app.get_webview(LABEL) {
            if frame.visible {
                view.set_bounds(frame.bounds()).map_err(|e| e.to_string())?;
                view.show().map_err(|e| e.to_string())?;
            } else {
                view.hide().map_err(|e| e.to_string())?;
            }
            if reload {
                view.reload().map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        // Do not load the remote page until the user opens the left board.
        if !frame.visible {
            return Ok(());
        }
        let on_load = on_load
            .ok_or("A load channel is required when creating the Trending webview")?
            .channel_on::<_, String>(caller);
        let nav_app = app.clone();
        let popup_app = app.clone();
        let on_title = on_load.clone();
        let builder = WebviewBuilder::new(LABEL, tauri::WebviewUrl::External(URL.parse().unwrap()))
            .bounds(frame.bounds())
            .incognito(true)
            .on_navigation(move |url| {
                if is_github_page(url) {
                    true
                } else {
                    open_link(&nav_app, url);
                    false
                }
            })
            .on_new_window(move |url, _| {
                if is_github_page(&url) {
                    // target=_blank and window.open use the same embedded view.
                    // Dispatch outside the native callback to avoid re-entering WebKit.
                    let app = popup_app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Some(view) = app.get_webview(LABEL)
                            && let Err(error) = view.navigate(url)
                        {
                            log::warn!("Unable to navigate GitHub page: {error}");
                        }
                    });
                } else {
                    open_link(&popup_app, &url);
                }
                NewWindowResponse::Deny
            })
            .on_download(|_, _| false)
            // GitHub also navigates with Turbo without a full document load.
            .on_document_title_changed(move |_, _| {
                let _ = on_title.send("updated".to_string());
            })
            .on_page_load(move |_, payload| {
                let event = match payload.event() {
                    PageLoadEvent::Started => "started",
                    PageLoadEvent::Finished => "finished",
                };
                let _ = on_load.send(event.to_string());
            });
        let view = window.add_child(builder).map_err(|e| e.to_string())?;
        // Only the bottom corners meet the outer panel edge. The top joins the toolbar.
        #[cfg(target_os = "macos")]
        view.with_webview(|platform| {
            use objc2::{
                msg_send,
                runtime::{AnyObject, Bool},
            };
            if let Some(webview) = platform.downcast_ref::<tauri_runtime_wry::Webview>() {
                unsafe {
                    let native: &AnyObject = &*webview.inner().cast();
                    let _: () = msg_send![native, setWantsLayer: Bool::YES];
                    let layer: *mut AnyObject = msg_send![native, layer];
                    if !layer.is_null() {
                        let _: () = msg_send![layer, setCornerRadius: 11.0_f64];
                        let flipped: Bool = msg_send![layer, isGeometryFlipped];
                        let bottom_corners: usize = if flipped.as_bool() { 12 } else { 3 };
                        let _: () = msg_send![layer, setMaskedCorners: bottom_corners];
                        let _: () = msg_send![layer, setMasksToBounds: Bool::YES];
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
        #[cfg(not(target_os = "macos"))]
        let _ = view;
        *current = Some(session);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_navigation_stays_embedded_including_repository_and_login_pages() {
        for url in [
            URL,
            "https://github.com/trending/rust?since=weekly",
            "https://github.com/trending/developers",
            "https://github.com/login",
            "https://github.com/owner/repo",
            "https://github.com/owner/repo/issues/1#issuecomment-123",
            "https://github.com/owner/repo/tree/main/src",
            "https://github.com/search?q=rust&type=repositories",
        ] {
            assert!(is_github_page(&url.parse().unwrap()), "{url}");
        }
    }
    #[test]
    fn external_and_privileged_navigation_cannot_enter_the_github_view() {
        for url in [
            "https://example.com/",
            "https://github.com.evil.test/trending",
            "http://github.com/trending",
            "tauri://localhost/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:secret@github.com/trending",
            "https://github.com:444/trending",
        ] {
            assert!(!is_github_page(&url.parse().unwrap()), "{url}");
        }
    }
    #[test]
    fn webview_geometry_rejects_invalid_numbers_and_empty_size() {
        let frame = Frame { x: 8.0, y: 50.0, width: 780.0, height: 500.0, visible: true };
        assert!(frame.validate().is_ok());
        assert!(Frame { width: 0.0, ..frame.clone() }.validate().is_err());
        assert!(Frame { x: -1.0, ..frame.clone() }.validate().is_err());
        assert!(Frame { height: f64::NAN, ..frame }.validate().is_err());
    }
}
