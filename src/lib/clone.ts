import { Channel, invoke } from "@tauri-apps/api/core"

import type { GitCommandResult } from "./git-result"

export { GitError as GitCommandError, isGitError } from "./git-error"
export type { GitCommandResult } from "./git-result"

import { GitError as GitCommandError } from "./git-error"
export async function clone(
  url: string,
  path: string,
  options: { branch?: string; defaultBranch?: string } = {},
  progressCallback?: (progress: { kind: "clone"; title: string; value: number; description?: string }) => void
) {
  progressCallback?.({ kind: "clone", title: `Cloning into ${path}`, value: 0 })
  const progress = new Channel<NonNullable<GitCommandResult["progress"]>[number]>()
  progress.onmessage = event =>
    progressCallback?.({
      kind: "clone",
      title: `Cloning into ${path}`,
      value: event.percent,
      description: event.kind === "progress" ? event.details.text : event.text
    })
  let result: GitCommandResult
  try {
    result = await invoke<GitCommandResult>("clone_repo_output", { url, path, options, progress })
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
  for (const event of result.progress ?? []) {
    progressCallback?.({
      kind: "clone",
      title: `Cloning into ${path}`,
      value: event.percent,
      description: event.kind === "progress" ? event.details.text : event.text
    })
  }
  if (result.exitCode !== 0) throw new GitCommandError(result)
}
