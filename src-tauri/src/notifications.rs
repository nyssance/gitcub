//! Desktop notification lifecycle. macOS uses the unchanged upstream manager;
//! Windows uses the same WinRT APIs with HRESULTs propagated before success.
use std::sync::{
    OnceLock,
    atomic::{AtomicBool, Ordering},
};
use tauri::Emitter;
static INITIALIZED: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
pub fn ensure_initialized() -> Result<(), String> {
    if INITIALIZED.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err("Cannot show notification: notifications not initialized.".into())
    }
}
fn emit(event: &str, id: &str, info: serde_json::Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit("desktop-notification-event", serde_json::json!({"event":event,"id":id,"userInfo":info}));
    }
}
pub fn initialize(app: tauri::AppHandle) -> Result<(), String> {
    let _ = APP.set(app);
    #[cfg(target_os = "macos")]
    unsafe {
        if !mac::gitcub_notifications_initialize(mac::event) {
            return Err("Native notifications require a macOS application bundle".into());
        }
    }
    INITIALIZED.store(true, Ordering::Release);
    Ok(())
}
pub fn permission() -> Result<String, String> {
    ensure_initialized()?;
    #[cfg(target_os = "macos")]
    {
        mac::call(|context, callback| unsafe { mac::gitcub_notifications_permission(context, callback) })
    }
    #[cfg(target_os = "windows")]
    {
        win::permission()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Native notifications are unavailable on this platform".into())
}
pub fn request_permission() -> Result<bool, String> {
    ensure_initialized()?;
    #[cfg(target_os = "macos")]
    {
        mac::call(|context, callback| unsafe { mac::gitcub_notifications_request(context, callback) })
            .map(|value| value == "true")
    }
    #[cfg(not(target_os = "macos"))]
    Ok(permission()? == "granted")
}
pub fn show(id: &str, title: &str, body: &str, info: serde_json::Value) -> Result<(), String> {
    ensure_initialized()?;
    #[cfg(target_os = "macos")]
    {
        let strings = [id.to_owned(), title.to_owned(), body.to_owned(), info.to_string()]
            .into_iter()
            .map(std::ffi::CString::new)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        mac::call(|context, callback| unsafe {
            mac::gitcub_notifications_show(
                strings[0].as_ptr(),
                strings[1].as_ptr(),
                strings[2].as_ptr(),
                strings[3].as_ptr(),
                context,
                callback,
            )
        })
        .map(|_| ())
    }
    #[cfg(target_os = "windows")]
    {
        win::show(id, title, body, info)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (id, title, body, info);
        Err("Native notifications are unavailable on this platform".into())
    }
}
pub fn close(id: &str) -> Result<(), String> {
    ensure_initialized()?;
    #[cfg(target_os = "macos")]
    {
        let id = std::ffi::CString::new(id).map_err(|e| e.to_string())?;
        unsafe {
            mac::gitcub_notifications_close(id.as_ptr());
        }
    }
    #[cfg(target_os = "windows")]
    {
        win::close(id)?;
    }
    Ok(())
}
pub fn terminate() {
    INITIALIZED.store(false, Ordering::Release);
    #[cfg(target_os = "macos")]
    unsafe {
        mac::gitcub_notifications_terminate();
    }
}
#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{CStr, c_char, c_void};
    type Callback = extern "C" fn(*mut c_void, *const c_char, *const c_char);
    unsafe extern "C" {
        pub fn gitcub_notifications_initialize(
            callback: extern "C" fn(*const c_char, *const c_char, *const c_char),
        ) -> bool;
        pub fn gitcub_notifications_permission(context: *mut c_void, callback: Callback);
        pub fn gitcub_notifications_request(context: *mut c_void, callback: Callback);
        pub fn gitcub_notifications_show(
            id: *const c_char, title: *const c_char, body: *const c_char, json: *const c_char, context: *mut c_void,
            callback: Callback,
        );
        pub fn gitcub_notifications_close(id: *const c_char);
        pub fn gitcub_notifications_terminate();
    }
    fn text(value: *const c_char) -> String {
        if value.is_null() { String::new() } else { unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned() }
    }
    pub extern "C" fn event(event: *const c_char, id: *const c_char, json: *const c_char) {
        super::emit(&text(event), &text(id), serde_json::from_str(&text(json)).unwrap_or(serde_json::Value::Null));
    }
    type Sender = std::sync::mpsc::Sender<Result<String, String>>;
    extern "C" fn completed(context: *mut c_void, error: *const c_char, value: *const c_char) {
        // The native completion block invokes this exactly once and owns the sender.
        let sender = unsafe { Box::from_raw(context.cast::<Sender>()) };
        let _ = sender.send(if error.is_null() { Ok(text(value)) } else { Err(text(error)) });
    }
    pub fn call(start: impl FnOnce(*mut c_void, Callback)) -> Result<String, String> {
        let (sender, receiver) = std::sync::mpsc::channel();
        start(Box::into_raw(Box::new(sender)).cast(), completed);
        receiver.recv().map_err(|e| e.to_string())?
    }
}
#[cfg(target_os = "windows")]
mod win {
    use std::sync::{Mutex, OnceLock};
    use windows::{
        Data::Xml::Dom::XmlDocument,
        Foundation::TypedEventHandler,
        UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
        core::HSTRING,
    };
    static ACTIVE: OnceLock<Mutex<std::collections::HashMap<String, ToastNotification>>> = OnceLock::new();
    fn app_id() -> HSTRING {
        HSTRING::from(super::APP.get().expect("Initialized application").config().identifier.as_str())
    }
    pub fn permission() -> Result<String, String> {
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&app_id()).map_err(|e| e.to_string())?;
        Ok(if notifier.Setting().map_err(|e| e.to_string())? == NotificationSetting::Enabled {
            "granted"
        } else {
            "denied"
        }
        .into())
    }
    fn escaped(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }
    pub fn show(id: &str, title: &str, body: &str, info: serde_json::Value) -> Result<(), String> {
        let operation = || -> windows::core::Result<()> {
            let xml = XmlDocument::new()?;
            xml.LoadXml(&HSTRING::from(format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",escaped(title),escaped(body))))?;
            let toast = ToastNotification::CreateToastNotification(&xml)?;
            let event_id = id.to_owned();
            toast.Activated(&TypedEventHandler::new(move |_, _| {
                super::emit("click", &event_id, info.clone());
                Ok(())
            }))?;
            let notifier = ToastNotificationManager::CreateToastNotifierWithId(&app_id())?;
            notifier.Show(&toast)?;
            ACTIVE
                .get_or_init(Default::default)
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(id.into(), toast);
            Ok(())
        };
        operation().map_err(|e| format!("Failed to show Windows toast notification (HRESULT {}): {e}", e.code().0))
    }
    pub fn close(id: &str) -> Result<(), String> {
        if let Some(toast) =
            ACTIVE.get_or_init(Default::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(id)
        {
            ToastNotificationManager::CreateToastNotifierWithId(&app_id())
                .and_then(|n| n.Hide(&toast))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
