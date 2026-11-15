import { Channel, invoke } from "@tauri-apps/api/core"

import type { GitProgressEvent } from "./fetch"
import type { HookCallbackOptions } from "./git-execution"
import { hookArgs, pushInterceptHooks } from "./hooks/with-hooks-env"

export interface PushProgress {
  kind: "push"
  title: string
  description?: string
  value: number
  remote: string
  branch: string
}

/** Desktop push argument and initial progress contract, using the native transport. */
export async function push(
  repository: { path: string },
  remote: { name: string },
  localBranch: string,
  remoteBranch: string | null,
  tagsToPush: readonly string[] | null,
  options?: { forceWithLease?: boolean; noVerify?: boolean } & HookCallbackOptions,
  progressCallback?: (progress: PushProgress) => void
) {
  const title = `Pushing to ${remote.name}`
  const progress = new Channel<GitProgressEvent>()
  progress.onmessage = event =>
    progressCallback?.({
      kind: "push",
      title,
      description: event.kind === "progress" ? event.details.text : event.text,
      value: event.percent,
      remote: remote.name,
      branch: localBranch
    })
  progressCallback?.({ kind: "push", title, value: 0, remote: remote.name, branch: localBranch })
  return invoke<void>("push_with_tags", {
    repo: repository.path,
    remote: remote.name,
    branch: remoteBranch ? `${localBranch}:${remoteBranch}` : localBranch,
    tags: tagsToPush ?? [],
    options: {
      setUpstream: !remoteBranch,
      forceWithLease: options?.forceWithLease ?? false,
      noVerify: options?.noVerify ?? false,
      progress: progressCallback !== undefined
    },
    progress,
    ...(await hookArgs(repository.path, pushInterceptHooks, options))
  })
}
