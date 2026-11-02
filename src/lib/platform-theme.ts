import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"

import { applyTheme } from "./theme"

let stopThemeListener: (() => void) | undefined
export function setNativeThemeSource(theme: "light" | "dark" | "system") {
  stopThemeListener?.()
  stopThemeListener = applyTheme(theme)
  if (isTauri())
    void getCurrentWindow()
      .setTheme(theme === "system" ? null : theme)
      .catch(error => log.error("Unable to apply window theme", error))
}
export async function shouldUseDarkColors() {
  return document.documentElement.classList.contains("dark")
}
