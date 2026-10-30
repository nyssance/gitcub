/** 全局 URI 导航 —— 一切都是链接。
 *
 * 形制照 alwith-desktop 的 features/navigation/navigate.ts，它又对标
 * Chrome（chrome://newtab）、Obsidian（obsidian://open）、VSCode（vscode://file）。
 *
 * 所有「打开什么」的动作统一收口到 navigate(uri)，右侧显示什么只认当前路由。
 * 不这么做就会变成一堆布尔量互相打架：右侧开着「发现」时点仓库没反应，
 * 因为 selectRepo 里忘了把 discovering 关掉——而这种地方每加一个视图就会漏一次。
 */

export type Route = { kind: "repo" } | { kind: "inbox" } | { kind: "mine" } | { kind: "stars" }

/** 路由表的 key 是 URL 的 host（`gitcub://discover` → host = "discover"） */
export const routes = {
  /** 打开某个仓库。path 是本地路径 */
  repo: (path: string) => `gitcub://repo?path=${encodeURIComponent(path)}`,
  /** 待我处理 */
  inbox: () => "gitcub://inbox",
  /** 趋势榜 */
  discover: () => "gitcub://discover",
  /** 我在各实例上的仓库 */
  mine: () => "gitcub://mine",
  /** 我 star 过的 */
  stars: () => "gitcub://stars",
  /** 设置对话框 */
  settings: () => "gitcub://settings"
}

export interface Parsed {
  host: string
  params: URLSearchParams
}

export function parse(uri: string): Parsed | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== "gitcub:") return null
    return { host: url.host, params: url.searchParams }
  } catch {
    return null
  }
}
