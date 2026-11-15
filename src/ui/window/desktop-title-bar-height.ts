// Desktop MIT port; minimum supported macOS version is 26.
import { platform } from "@tauri-apps/plugin-os"

export function getTitleBarHeight() {
  return platform() === "macos" ? 32 : 28
}
