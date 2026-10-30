import { execFileSync } from "node:child_process"
import { release } from "node:os"
export function platform() {
  const flags = globalThis as typeof globalThis & { __WIN32__?: boolean; __DARWIN__?: boolean }
  return flags.__WIN32__ ? "windows" : flags.__DARWIN__ ? "macos" : "linux"
}

export function version() {
  return process.platform === "darwin"
    ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()
    : release()
}
export const type = platform

export const arch = () => (process.arch === "arm64" ? "aarch64" : process.arch)
