/** Desktop API shapes over the application's native Git implementation. */
import { invoke } from "@tauri-apps/api/core"

import { Branch, BranchType } from "../models/branch"
import type { Commit } from "../models/commit"
import type { RepoStatus } from "../models/repo-status"
import type { Repository } from "../models/repository"
import { DiffSelection, DiffSelectionType } from "../upstream/models/diff"
import type { IRevertProgress } from "../upstream/models/progress"
import type { IRemote } from "../upstream/models/remote"
import { type IStashEntry, StashedChangesLoadStates } from "../upstream/models/stash-entry"
import { WorkingDirectoryFileChange, WorkingDirectoryStatus } from "../upstream/models/status"
import { getCommits } from "./commit-history"
import { appStatus } from "./desktop-status"
import { GitError } from "./git-error"
import { executeGit } from "./git-execution"
import type { IStatusResult } from "./status-contract"

export { getAheadBehind } from "./ahead-behind"
export * from "./commit-trailers"
export { fetch } from "./fetch"
export * from "./git/checkout-index"
export * from "./git/checkout-paths"
export * from "./git/diff-index"
export * from "./git/reset"
export * from "./git/rev-range"
export * from "./git/rm"
export * from "./git/update-ref"
export { GitError } from "./git-error"
export type { IStatusResult }
export { getCommits }

import type { ITextDiff } from "../upstream/models/diff"
import { discardSelection } from "./stage"
export const discardChangesFromSelection = (
  repo: Repository,
  path: string,
  diff: ITextDiff,
  selection: DiffSelection
) => discardSelection(repo.path, path, diff, selection)
export const getCommit = async (repo: Repository, revision: string) => (await getCommits(repo, revision, 1))[0] ?? null
interface BranchInfo {
  name: string
  upstream: string | null
  sha: string
  remote: boolean
  reference: string
}
export async function getBranches(repo: Repository, pattern?: string) {
  const branches = await invoke<BranchInfo[]>("branch_details", { repo: repo.path, pattern: pattern ?? null })
  return branches.map(
    b => new Branch(b.name, b.upstream, { sha: b.sha }, b.remote ? BranchType.Remote : BranchType.Local, b.reference)
  )
}
export const createBranch = (repo: Repository, name: string, startPoint: string | null, noTrack = false) =>
  invoke<void>("create_branch", { repo: repo.path, name, startPoint, noTrack })
export const getRecentBranches = (repo: Repository, limit: number) =>
  invoke<string[]>("recent_branches", { repo: repo.path, limit })
export async function getRemotes(repo: Repository): Promise<IRemote[]> {
  const remotes = await invoke<[string, string][]>("remotes", { repo: repo.path })
  return remotes.map(([name, url]) => ({ name, url }))
}
export async function setRemoteURL(repo: Repository, name: string, url: string) {
  await invoke<void>("set_remote_url", { repo: repo.path, name, url })
  return true
}
export const addRemote = (repo: Repository, name: string, url: string) =>
  invoke<void>("add_remote", { repo: repo.path, name, url })
export const removeRemote = (repo: Repository, name: string) => invoke<void>("remove_remote", { repo: repo.path, name })
export const fetchRefspec = (repo: Repository, remote: IRemote, refspec: string) =>
  invoke<void>("fetch_refspec", { repo: repo.path, remote: remote.name, refspec })
export const updateRemoteHEAD = (repo: Repository, remote: IRemote, background: boolean) =>
  invoke<void>("update_remote_head", { repo: repo.path, name: remote.name, background })
export const getRemoteHEAD = (repo: Repository, remote: string) =>
  invoke<string | null>("get_remote_head", { repo: repo.path, remote })
export const getConfigValue = (repo: Repository, key: string, onlyLocal = false) =>
  invoke<string | null>("get_config_value", { repo: repo.path, key, onlyLocal })
export const getGlobalConfigValue = (key: string) => invoke<string | null>("global_config_value", { key })
/** Desktop setConfigValue：仓库级 `git config --replace-all` */
export async function setConfigValue(repo: Repository, key: string, value: string) {
  const result = await executeGit(["config", "--replace-all", key, value], repo.path, "setConfigValueInPath")
  if (result.exitCode !== 0) throw new GitError(result)
}
/** Desktop removeConfigValue：`git config --unset-all`；本来就没设（退出码 5）不算失败 */
export async function removeConfigValue(repo: Repository, key: string) {
  const result = await executeGit(["config", "--unset-all", key], repo.path, "removeConfigValueInPath", {
    successExitCodes: new Set([0, 5])
  })
  if (result.exitCode !== 0 && result.exitCode !== 5) throw new GitError(result)
}
export async function setGlobalConfigValue(key: string, value: string) {
  const path = await invoke<string>("working_directory")
  const result = await executeGit(["config", "--global", key, value], path, "setGlobalConfigValue", {
    expectedErrors: new Set(["ConfigLockFileAlreadyExists"])
  })
  if (result.exitCode !== 0) throw new GitError(result)
}
export async function getStatus(repo: Repository): Promise<IStatusResult | null> {
  const kind = await invoke<{ kind: string }>("repository_type", { path: repo.path })
  if (kind.kind === "missing") return null
  const [status, tip, rebaseInternalState] = await Promise.all([
    invoke<RepoStatus>("repo_status", { repo: repo.path }),
    invoke<{ kind: string; branch?: BranchInfo; currentSha?: string }>("repository_tip", { repo: repo.path }),
    invoke<IStatusResult["rebaseInternalState"]>("rebase_internal_state", { repo: repo.path })
  ])
  const branch = tip.branch
  return {
    exists: true,
    currentBranch: status.branch ?? undefined,
    currentTip: branch?.sha ?? tip.currentSha,
    currentUpstreamBranch: branch?.upstream ?? undefined,
    branchAheadBehind: status.hasUpstream ? { ahead: status.ahead, behind: status.behind } : undefined,
    mergeHeadFound: status.operation === "merge",
    squashMsgFound: await invoke<boolean>("git_metadata_exists", { repo: repo.path, name: "SQUASH_MSG" }),
    isCherryPickingHeadFound: status.operation === "cherry-pick",
    rebaseInternalState,
    doConflictedFilesExist: status.changes.some(f => f.change === "conflicted"),
    workingDirectory: WorkingDirectoryStatus.fromFiles(
      status.changes.map(
        f =>
          new WorkingDirectoryFileChange(
            f.path,
            appStatus(f),
            DiffSelection.fromInitialSelection(DiffSelectionType.All)
          )
      )
    )
  }
}
export const createTag = (repo: Repository, name: string, sha: string) =>
  invoke<void>("create_tag", { repo: repo.path, name, sha })
export const deleteTag = (repo: Repository, name: string) => invoke<void>("delete_tag", { repo: repo.path, name })
export async function getAllTags(repo: Repository) {
  return new Map(Object.entries(await invoke<Record<string, string>>("tag_targets", { repo: repo.path })))
}
export const listSubmodules = (repo: Repository) =>
  invoke<Array<{ path: string; url: string; name: string }>>("list_submodules", { repo: repo.path })
export const resetSubmodulePaths = (repo: Repository, paths: readonly string[]) =>
  invoke<void>("reset_submodules", { repo: repo.path, paths })
export { formatCommitMessage } from "./format-commit-message"

interface StashEntry {
  name: string
  sha: string
  branchName: string | null
  ours: boolean
  tree: string
  parents: string[]
}
export async function getStashes(repo: Repository) {
  const entries = await invoke<StashEntry[]>("stashes", { repo: repo.path })
  return {
    stashEntryCount: entries.length,
    desktopEntries: entries
      .filter(e => e.ours && e.branchName !== null)
      .map((e): IStashEntry => ({
        name: `refs/${e.name}`,
        stashSha: e.sha,
        // Preserve the original Desktop implementation and contract.
        branchName: e.branchName!,
        tree: e.tree,
        parents: e.parents,
        files: { kind: StashedChangesLoadStates.NotLoaded }
      }))
  }
}
export { getStashedFiles } from "./git/stashed-files"
export async function revertCommit(
  repo: Repository,
  commit: Commit,
  remote: IRemote | null,
  progress?: (value: IRevertProgress) => void
) {
  progress?.({ kind: "revert", title: `Reverting ${commit.shortSha}`, value: 0 })
  await invoke<void>("revert_commit", {
    repo: repo.path,
    sha: commit.sha,
    isMerge: commit.parentSHAs.length > 1,
    remote
  })
  progress?.({ kind: "revert", title: `Reverted ${commit.shortSha}`, value: 1 })
}
export { type MergeOptions, MergeResult, merge } from "./git/merge"
export * from "./git/merged-branches"
export * from "./git/refs"
export async function deleteLocalBranch(repo: Repository, name: string) {
  await invoke<void>("delete_branch", { repo: repo.path, name })
  return true
}
export const listWorktrees = (repo: Repository) =>
  invoke<import("../models/worktree").WorktreeEntry[]>("worktrees", { repo: repo.path })
export async function getBranchCheckouts(repo: Repository, after: Date) {
  return new Map(
    Object.entries(
      await invoke<Record<string, string>>("branch_checkouts", { repo: repo.path, after: after.toISOString() })
    ).map(([name, date]) => [name, new Date(date)])
  )
}
