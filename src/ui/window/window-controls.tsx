import { getCurrentWindow } from "@tauri-apps/api/window"
import { useEffect, useState } from "react"

import { Button as StandardButton } from "@/components/ui/button"

/** Windows 上的最小化 / 最大化 / 关闭按钮。
 *
 * 照搬原版 window-controls.tsx —— Windows 走 `frame: false`（原版
 * app-window.ts 里的 `windowOptions.frame = false`），系统标题栏没了，
 * 这三个按钮和下面的 resize-handle 都得自己画。SVG 路径直接取自原版。 */
const closePath = "M 0,0 0,0.7 4.3,5 0,9.3 0,10 0.7,10 5,5.7 9.3,10 10,10 10,9.3 5.7,5 10,0.7 10,0 9.3,0 5,4.3 0.7,0 Z"
const maximizePath = "M 0,0 0,10 10,10 10,0 Z M 1,1 9,1 9,9 1,9 Z"
const minimizePath = "M 0,5 10,5 10,6 0,6 Z"
const restorePath = "m 2,1e-5 0,2 -2,0 0,8 8,0 0,-2 2,0 0,-8 z m 1,1 6,0 0,6 -1,0 0,-5 -5,0 z m -2,2 6,0 0,6 -6,0 z"

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  const win = getCurrentWindow()

  useEffect(() => {
    let alive = true
    void win.isMaximized().then(m => alive && setMaximized(m))
    const un = win.onResized(() => {
      void win.isMaximized().then(m => alive && setMaximized(m))
    })
    return () => {
      alive = false
      void un.then(f => f())
    }
  }, [win])

  const button = (name: string, onClick: () => void, path: string) => (
    <StandardButton
      variant="ghost"
      type="button"
      className={`window-control ${name}`}
      onClick={onClick}
      aria-label={name}>
      <svg aria-hidden viewBox="0 0 10 10" width="10" height="10">
        <path d={path} />
      </svg>
    </StandardButton>
  )

  return (
    <div className="window-controls">
      {button("minimize", () => void win.minimize(), minimizePath)}
      {button("maximize", () => void win.toggleMaximize(), maximized ? restorePath : maximizePath)}
      {button("close", () => void win.close(), closePath)}
    </div>
  )
}
