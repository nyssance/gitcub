import { Channel, invoke } from "@tauri-apps/api/core"

import { GitCommandError, type GitCommandResult } from "./clone"
import type { HookCallbackOptions } from "./git-execution"
import { hookArgs, pullInterceptHooks } from "./hooks/with-hooks-env"
export interface RemoteProgress {
  kind: "fetch" | "pull"
  title: string
  description?: string
  value: number
  remote: string
}

/** 后端 progress.rs 的 Progress：解析出的步骤或其他上下文行 */
export type GitProgressEvent = NonNullable<GitCommandResult["progress"]>[number]

/** Desktop fetch.ts / pull.ts 的进度回调：除了 `remote: Counting objects` 之外的上下文行（引用更新等）不进进度 */
function remoteProgressChannel<K extends RemoteProgress["kind"]>(
  kind: K,
  title: string,
  remote: string,
  progressCallback?: (progress: RemoteProgress & { kind: K }) => void
) {
  const channel = new Channel<GitProgressEvent>()
  channel.onmessage = progress => {
    if (progress.kind === "context" && !progress.text.startsWith("remote: Counting objects")) return
    const description = progress.kind === "progress" ? progress.details.text : progress.text
    progressCallback?.({ kind, title, description, value: progress.percent, remote } as RemoteProgress & { kind: K })
  }
  return channel
}
export async function fetch(
  repository: { path: string },
  remote: { name: string },
  progressCallback?: (progress: RemoteProgress & { kind: "fetch" }) => void,
  backgroundTask = false
) {
  const title = `Fetching ${remote.name}`
  const progress = remoteProgressChannel("fetch", title, remote.name, progressCallback)
  progressCallback?.({ kind: "fetch", title, value: 0, remote: remote.name })
  const result = await invoke<GitCommandResult>("fetch_output", {
    repo: repository.path,
    remote: remote.name,
    options: { progress: progressCallback !== undefined, backgroundTask },
    progress
  })
  if (result.exitCode !== 0) throw new GitCommandError(result)
}
export async function pull(
  repository: { path: string },
  remote: { name: string },
  options?: { noVerify?: boolean; progressCallback?: (progress: RemoteProgress) => void } & HookCallbackOptions
) {
  if (remote.name.startsWith("-")) throw new Error("Cannot pull from a remote whose name starts with '-'.")
  const title = `Pulling ${remote.name}`
  const progress = remoteProgressChannel("pull", title, remote.name, options?.progressCallback)
  options?.progressCallback?.({ kind: "pull", title, value: 0, remote: remote.name })
  const result = await invoke<GitCommandResult>("pull_output", {
    repo: repository.path,
    remote: remote.name,
    options: { noVerify: options?.noVerify ?? false, progress: options?.progressCallback !== undefined },
    progress,
    ...(await hookArgs(repository.path, pullInterceptHooks, options))
  })
  if (result.exitCode !== 0) throw new GitCommandError(result)
}
