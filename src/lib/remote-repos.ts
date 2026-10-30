import type { RemoteRepo } from "@/models/app-state"

/** 刷新时某个实例读取失败：保留它上次成功显示的仓库。
 *  列表按实例分别请求、到一个替换一次，否则别的实例的新结果会把失败实例的旧行挤掉，
 *  看起来像那个实例没有仓库。 */
export function keepLastSuccessful(seen: Map<string, RemoteRepo>, previous: readonly RemoteRepo[], host: string) {
  for (const repo of previous) if (repo.host === host && !seen.has(repo.url)) seen.set(repo.url, repo)
  return seen
}
