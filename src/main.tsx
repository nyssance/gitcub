import "@/lib/browser-runtime"
import "@/lib/log"
import { isTauri } from "@tauri-apps/api/core"
import { platform } from "@tauri-apps/plugin-os"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { initializePlatformEnvironment } from "@/lib/platform-environment"
import "@/lib/i18n"
import "@/styles/globals.css"
import { buildDefaultMenu } from "@/lib/menu/build-default-menu"
import { Application } from "@/ui/application"

const root = document.getElementById("root")
// index.html 里没有 #root 的话，整个应用什么都不会发生。与其让 React 抛一句
// 看不懂的错，不如在这里直说。
if (!root) throw new Error("index.html 里找不到 #root")

const render = () =>
  createRoot(root).render(
    <StrictMode>
      <Application />
    </StrictMode>
  )

if (isTauri()) {
  const nativePlatform = platform()
  document.body.classList.add(
    `platform-${nativePlatform === "macos" ? "darwin" : nativePlatform === "windows" ? "win32" : nativePlatform}`
  )
  initializePlatformEnvironment()
    .then(async () => {
      const menu = await buildDefaultMenu({
        selectedExternalEditor: null,
        selectedShell: null,
        askForConfirmationOnForcePush: true,
        askForConfirmationOnRepositoryRemoval: true
      })
      await menu.setAsAppMenu()
      render()
    })
    .catch(error => {
      console.error(error)
      render()
    })
} else {
  render()
}
