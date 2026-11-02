import { platform } from "@tauri-apps/plugin-os"
export const __WIN32__ = platform() === "windows"
export const __DARWIN__ = platform() === "macos"

export const __LINUX__ = platform() === "linux"
