import { type } from "@tauri-apps/plugin-os"
import { useEffect, useState } from "react"

import { WindowControls } from "./window-controls"

/** 标题栏。结构照原版 title-bar.tsx / _title-bar.scss。
 *
 * macOS：`titleBarStyle: Overlay`，红绿灯浮在内容上，这里只留出高度和拖拽区
 *        （原版 --darwin-title-bar-height: 22px）。
 * Windows：`frame: false`，系统标题栏没了，自己画图标 + 三个窗口按钮 +
 *        四周的 resize handle（原版 --win32-title-bar-height: 28px）。 */
/** 当前是不是 Windows。macOS 上红绿灯由布局自己让位（左栏顶部留白），
 * 只有 Windows（frame:false）才需要整条标题栏来放自绘按钮和缩放边框。 */
export function useIsWindows() {
  const [isWin, setIsWin] = useState(false)
  useEffect(() => {
    try {
      setIsWin(type() === "windows")
    } catch {
      setIsWin(false)
    }
  }, [])
  return isWin
}

export function TitleBar({ children }: { children?: React.ReactNode }) {
  const [os, setOs] = useState<string>("")

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

  const isWin = os === "windows"

  return (
    <div id="title-bar" className={isWin ? "win32" : "darwin"} data-tauri-drag-region>
      {/* frame:false 之后 OS 的缩放边框也没了，得自己补 —— 原版 .resize-handle */}
      {isWin && <div className="resize-handle top" />}
      {isWin && <div className="resize-handle left" />}
      {children}
      {isWin && <WindowControls />}
    </div>
  )
}
