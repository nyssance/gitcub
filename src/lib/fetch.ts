import { invoke } from "@tauri-apps/api/core"

import { GitCommandError, type GitCommandResult } from "./clone"
export interface RemoteProgress {
  kind: "fetch" | "pull"
  title: string
  value: number
  remote: string
}
export async function fetch(
  repository: { path: string },
  remote: { name: string },
  progressCallback?: (progress: RemoteProgress & { kind: "fetch" }) => void,
  backgroundTask = false
) {
  progressCallback?.({ kind: "fetch", title: `Fetching ${remote.name}`, value: 0, remote: remote.name })
  const result = await invoke<GitCommandResult>("fetch_output", {
    repo: repository.path,
    remote: remote.name,
    options: { progress: progressCallback !== undefined, backgroundTask }
  })
  if (result.exitCode !== 0) throw new GitCommandError(result)
}
export async function pull(
  repository: { path: string },
  remote: { name: string },
  options?: { noVerify?: boolean; progressCallback?: (progress: RemoteProgress) => void }
) {
  if (remote.name.startsWith("-")) throw new Error("Cannot pull from a remote whose name starts with '-'.")
  options?.progressCallback?.({ kind: "pull", title: `Pulling ${remote.name}`, value: 0, remote: remote.name })
  const result = await invoke<GitCommandResult>("pull_output", {
    repo: repository.path,
    remote: remote.name,
    options: { noVerify: options?.noVerify ?? false, progress: options?.progressCallback !== undefined }
  })
  if (result.exitCode !== 0) throw new GitCommandError(result)
}
