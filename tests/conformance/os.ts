import { execFileSync } from "node:child_process"
import { release } from "node:os"
export function platform() {
  const flags = globalThis as typeof globalThis & { __WIN32__?: boolean; __DARWIN__?: boolean }
  if (flags.__DARWIN__) return "macos"
  if (flags.__WIN32__) return "windows"
  // A suite that clears __WIN32__ on a Windows host is simulating another platform.
  if (flags.__WIN32__ === false && process.platform === "win32") return "macos"
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
}

export function version() {
  return process.platform === "darwin"
    ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()
    : release()
}
export const type = platform

export const arch = () => (process.arch === "arm64" ? "aarch64" : process.arch)
