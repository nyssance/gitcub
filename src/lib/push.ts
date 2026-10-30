import { invoke } from "@tauri-apps/api/core"

export interface PushProgress {
  kind: "push"
  title: string
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
  options?: { forceWithLease?: boolean; noVerify?: boolean },
  progressCallback?: (progress: PushProgress) => void
) {
  progressCallback?.({
    kind: "push",
    title: `Pushing to ${remote.name}`,
    value: 0,
    remote: remote.name,
    branch: localBranch
  })
  return invoke<void>("push_with_tags", {
    repo: repository.path,
    remote: remote.name,
    branch: remoteBranch ? `${localBranch}:${remoteBranch}` : localBranch,
    tags: tagsToPush ?? [],
    options: {
      setUpstream: !remoteBranch,
      forceWithLease: options?.forceWithLease ?? false,
      noVerify: options?.noVerify ?? false
    }
  })
}
