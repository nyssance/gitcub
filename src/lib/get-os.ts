// Desktop MIT port; platform imports adapted to Tauri.
import { platform, type, version } from "@tauri-apps/plugin-os"
import { compare } from "compare-versions"
import memoizeOne from "memoize-one"

function getSystemVersionSafe() {
  return version()
}

function systemVersionGreaterThanOrEqualTo(version: string) {
  const sysver = getSystemVersionSafe()
  return sysver === undefined ? false : compare(sysver, version, ">=")
}

function systemVersionLessThan(version: string) {
  const sysver = getSystemVersionSafe()
  return sysver === undefined ? false : compare(sysver, version, "<")
}

/** Get the OS we're currently running on. */
export function getOS(): string {
  const version = getSystemVersionSafe()
  if (platform() === "macos") {
    return `Mac OS ${version}`
  } else if (platform() === "windows") {
    return `Windows ${version}`
  } else {
    return `${type()} ${version}`
  }
}

/** We're currently running Windows 10 and it is at least 1809 Preview Build 17666. */
export const isWindows10And1809Preview17666OrLater = memoizeOne(
  () => platform() === "windows" && systemVersionGreaterThanOrEqualTo("10.0.17666")
)

export const isWindowsAndNoLongerSupportedByElectron = memoizeOne(
  () => platform() === "windows" && systemVersionLessThan("10")
)
