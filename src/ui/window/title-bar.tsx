import { DesktopWindowsShell, useDesktopZoom } from "@alwith/module-desktop-shell/react"
import { isTauri } from "@tauri-apps/api/core"
import { type } from "@tauri-apps/plugin-os"
import { useEffect, useState } from "react"

import appIcon from "../../../src-tauri/icons/64x64.png"

export function TitleBar({ children }: { children?: React.ReactNode }) {
  const [os, setOs] = useState<string>("")
  const { level: zoom } = useDesktopZoom()

  useEffect(() => {
    let current: string
    try {
      current = type()
    } catch {
      current = "macos"
    }
    setOs(current)
    // 标题栏高度是 :root 上的变量（内容区要用它算高度），平台在这里落到 html 上
    document.documentElement.dataset.platform = current
  }, [])

  return (
    <DesktopWindowsShell
      icon={appIcon}
      title="GitCub"
      zoom={zoom}
      enabled={isTauri() && os === "windows"}
    >
      {children}
    </DesktopWindowsShell>
  )
}
