// Desktop MIT port: app/src/lib/rebase.ts ForcePushBranchState / getCurrentBranchForcePushState.
// GitCub has no branchesState: the branch, its tip and ahead/behind come from the repository status, and
// forcePushBranches from the repository store (branch → tip after this app rewrote it).
import type { RepoStatus } from "@/models/repo-status"

export enum ForcePushBranchState {
  NotAvailable,
  Available,
  Recommended
}

/**
 * Check application state to see whether the action applied to the current
 * branch should be a force push
 */
export function getCurrentBranchForcePushState(
  status: Pick<RepoStatus, "branch" | "head" | "hasUpstream" | "ahead" | "behind">,
  forcePushBranches: Readonly<Record<string, string>> | undefined
): ForcePushBranchState {
  if (!status.hasUpstream) {
    // no tracking branch found
    return ForcePushBranchState.NotAvailable
  }

  const { ahead, behind } = status

  if (behind === 0 || ahead === 0) {
    // no a diverged branch to force push
    return ForcePushBranchState.NotAvailable
  }

  let canForcePushBranch = false
  if (status.branch !== null && status.head !== null) {
    const foundEntry = forcePushBranches?.[status.branch]
    canForcePushBranch = foundEntry === status.head
  }

  return canForcePushBranch ? ForcePushBranchState.Recommended : ForcePushBranchState.Available
}
