import type { Remote } from "@/models/app-state"

/**
 * 实例标识是 `hostname[:port][/子路径]`：GitLab 可以部署在 `https://host/gitlab` 这样的子路径下，
 * 接口在 `<实例>/api/v4`，网页在 `<实例>/<owner>/<name>`。与 src-tauri/src/remote.rs 同一规则。
 */
export function splitInstance(instance: string): [authority: string, path: string] {
  const slash = instance.indexOf("/")
  if (slash === -1) return [instance, ""]
  return [instance.slice(0, slash), instance.slice(slash + 1).replaceAll(/^\/+|\/+$/g, "")]
}

/** 远端落在这个实例下时返回改写后的远端：host 换成实例标识，owner 去掉子路径（按整段匹配）。 */
export function remoteWithin(remote: Remote, instance: string): Remote | null {
  const [authority, path] = splitInstance(instance)
  if (authority.toLowerCase() !== remote.host.toLowerCase()) return null
  if (path === "") return { ...remote, host: instance }
  const head = remote.owner.slice(0, path.length)
  const rest = remote.owner.slice(path.length)
  if (head.toLowerCase() !== path.toLowerCase() || !rest.startsWith("/") || rest.length === 1) return null
  return { ...remote, host: instance, owner: rest.slice(1) }
}

/**
 * 远端 → 账号实例。先按 URL 取子路径最长的已知实例；匹配不上时（SSH 远端既不带 Web 端口也不带子路径），
 * 按 Desktop `matchGitHubRepository`（app/src/lib/repository-matching.ts）的 hostname 匹配。
 */
export function accountRemoteFor(remote: Remote, knownHosts: readonly string[]): Remote {
  let best: Remote | null = null
  let bestLength = -1
  for (const known of knownHosts) {
    const resolved = remoteWithin(remote, known)
    const length = splitInstance(known)[1].length
    if (resolved && length >= bestLength) {
      best = resolved
      bestLength = length
    }
  }
  return best ?? { ...remote, host: accountHostFor(remote.host, knownHosts) }
}

/**
 * 远端主机 → 账号主机。GitCub 按实例标识记账号；SSH 远端解析出的主机不带端口
 * （SSH 端口不是 Web/API 端口），自建实例的 HTTPS 又可能在非标准端口或子路径上。
 * Desktop `matchGitHubRepository`（app/src/lib/repository-matching.ts）按 hostname 匹配账号，
 * 这里同样：没有完全相同的账号主机时，唯一一个 hostname 相同的账号实例就是它；
 * 有多个候选（同一主机上多个端口或子路径的实例）时无法判断，保持原样。
 */
export function accountHostFor(host: string, knownHosts: readonly string[]): string {
  if (host.includes(":") && !host.startsWith("[")) return host
  if (/^\[.*\]:\d+$/.test(host)) return host
  if (knownHosts.includes(host)) return host
  const hostname = host.toLowerCase()
  const candidates = knownHosts.filter(known => known !== host && hostnameOf(known) === hostname)
  return candidates.length === 1 ? candidates[0]! : host
}

/**
 * 设置里手动添加的实例地址 → 实例标识：小写 hostname、非默认端口、去掉末尾斜杠的子路径。
 * 带账号、查询串、片段或 `.` / `..` 段的地址不是实例基址，返回 null。
 */
export function instanceFromURL(url: URL): string | null {
  if (url.username || url.password || url.search || url.hash) return null
  const path = url.pathname.replace(/\/+$/, "")
  if (path === "") return url.host
  const segments = path.slice(1).split("/")
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return null
  return `${url.host}${path}`
}

function hostnameOf(host: string): string | null {
  try {
    return new URL(`https://${host}`).hostname.toLowerCase()
  } catch {
    return null
  }
}
