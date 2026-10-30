import { platform, version } from "@tauri-apps/plugin-os"
export function supportsNotifications() {
  const os = platform()
  const [major = 0, minor = 0, build = 15063] = version().split(".").map(Number)
  return os === "macos"
    ? major > 10 || (major === 10 && minor >= 14)
    : os === "windows" && (major > 10 || (major === 10 && build >= 15063))
}
export const supportsNotificationsPermissionRequest = () => platform() === "macos" && supportsNotifications()
