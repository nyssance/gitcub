import { parseEnumValue } from "@/upstream/lib/enum"

/** 应用主题。
 *
 * `.dark` 类挂在 documentElement 上，globals.css 里的 `.dark {}` 覆盖一整套
 * token。system 模式跟随 prefers-color-scheme 并监听变化。 */
export function applyTheme(theme: string): () => void {
  theme = parseEnumValue({ dark: "dark", light: "light", system: "system" } as const, theme) ?? "system"
  const root = document.documentElement
  const set = (dark: boolean) => {
    root.classList.toggle("dark", dark)
    document.body.classList.toggle("theme-dark", dark)
  }

  if (theme === "dark") {
    set(true)
    return () => {}
  }
  if (theme === "light") {
    set(false)
    return () => {}
  }

  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  set(mq.matches)
  const onChange = (e: MediaQueryListEvent) => set(e.matches)
  mq.addEventListener("change", onChange)
  return () => mq.removeEventListener("change", onChange)
}
