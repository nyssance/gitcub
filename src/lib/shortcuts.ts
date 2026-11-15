/** 全局快捷键。键位照原版 build-default-menu.ts 的 accelerator，一个不改——
 *  从 GitHub Desktop 过来的人肌肉记忆是现成的，自创键位等于让他们重学。
 *
 *    ⌘1 / ⌘2 / ⌘3   更改 / 历史 / 合并请求
 *    ⌘T             仓库列表（我们是左栏搜索框）
 *    ⌘B             分支列表
 *    ⌘G             跳到提交摘要输入框
 *    ⌘P / ⌘⇧P / ⌘⇧T  推送 / 拉取 / 获取
 *    ⌘,             设置
 *
 * 焦点在输入框里时除了 ⌘ 组合键一概不拦——用户正在打字。 */

export interface ShortcutHandlers {
  onTab: (tab: string) => void
  onFocusRepoSearch: () => void
  onOpenBranches: () => void
  onFocusSummary: () => void
  onPush: () => void
  onPull: () => void
  onFetch: () => void
  onPreferences: () => void
}

export function handleShortcut(e: KeyboardEvent, h: ShortcutHandlers): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false

  const shift = e.shiftKey
  switch (e.key.toLowerCase()) {
    case "1":
      h.onTab("changes")
      break
    case "2":
      h.onTab("history")
      break
    case "3":
      h.onTab("pr")
      break
    case "t":
      if (shift) h.onFetch()
      else h.onFocusRepoSearch()
      break
    case "b":
      h.onOpenBranches()
      break
    case "g":
      h.onFocusSummary()
      break
    case "p":
      if (shift) h.onPull()
      else h.onPush()
      break
    case ",":
      h.onPreferences()
      break
    default:
      return false
  }
  e.preventDefault()
  return true
}
