import { type } from "@tauri-apps/plugin-os"
import { useEffect, useState } from "react"

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
