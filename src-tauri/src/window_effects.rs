//! 窗口背景效果。
//!
//! 做法和 alwith-desktop 一致：**整窗开 vibrancy，内容区盖不透明底色，
//! 只让侧栏透出来**——这也是 Finder / Mail / Xcode 的标准做法。
//! Tauri 的窗口效果是作用在整个窗口上的，没法只给某个区域开，
//! 所以分区靠 CSS：侧栏背景透明，右侧内容区不透明。
//!
//! macOS 用 `Effect::UnderWindowBackground`（照 alwith-u 的 lib.rs）。
//! Tauri 3 直接通过 `transparent: true` 开启窗口透明。
//! Windows 优先 Mica，Windows 10 退回 Acrylic。

#[cfg(target_os = "macos")]
pub fn apply(window: &tauri::WebviewWindow) {
    use tauri::window::{Effect, EffectsBuilder};

    if let Err(e) = window.set_effects(EffectsBuilder::new().effect(Effect::UnderWindowBackground).build()) {
        // 效果不是必需品，失败就退化成不透明窗口，不该让应用起不来
        log::warn!("窗口 vibrancy 应用失败: {e}");
    }
}

#[cfg(target_os = "windows")]
pub fn apply(window: &tauri::WebviewWindow) {
    use window_vibrancy::{Error, apply_acrylic, apply_mica};

    // alwith-desktop 踩过的坑：透明窗 + DWM 不绘制（系统「透明效果」被组策略
    // 关掉 / 远程桌面会话）会合成到未初始化显存，表现为全屏雪花噪点。
    // 所以失败时不 panic，静默退化成不透明。
    match apply_mica(window, None) {
        Ok(()) => {}
        // Windows 10 不支持 Mica，只对这个明确的能力边界改用 Acrylic
        Err(Error::UnsupportedPlatformVersion(_)) => {
            let _ = apply_acrylic(window, None);
        }
        Err(e) => log::warn!("窗口 Mica 应用失败: {e}"),
    }
}
