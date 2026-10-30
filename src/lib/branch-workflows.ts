import type { BranchDetails } from "../models/app-state"
import type { RepoStatus } from "../models/repo-status"

const workflowErrors = {
  branchChanged: "The current branch or Git operation changed. Review the repository before trying again.",
  operationInProgress: "Finish the current Git operation before trying again.",
  detached: "Create or switch to a branch before trying again.",
  noUpstream: "This branch has no remote to push to.",
  noRemotes: "The repository has no remotes."
}

export class BranchWorkflowError extends Error {
  constructor(public readonly code: keyof typeof workflowErrors) {
    super(workflowErrors[code])
  }
}

export interface BranchGit {
  repoStatus(repo: string): Promise<RepoStatus>
  checkout(repo: string, branch: string): Promise<unknown>
  stashPush(repo: string, branch: string): Promise<unknown>
}

/** Match Desktop's overwritten-local-changes recovery. The caller owns the
 * operation lock; recovery must not acquire that lock a second time.
 * `true` stashes on the current branch first (Desktop StashOnCurrentBranch);
 * `"carry"` retries the checkout with the changes in place (MoveToNewBranch).
 */
export async function checkoutWithStash(
  repo: string,
  branch: string,
  git: BranchGit,
  confirmStash: (target: string, current: string) => Promise<boolean | "carry">
) {
  const before = await git.repoStatus(repo)
  try {
    await git.checkout(repo, branch)
  } catch (error) {
    if (!/would be overwritten|commit your changes or stash/i.test(String(error))) throw error
    const choice = await confirmStash(branch, before.branch ?? "")
    if (!choice) return
    await assertSameBranch(repo, before.branch, git)
    if (choice !== "carry") await git.stashPush(repo, before.branch ?? "")
    await git.checkout(repo, branch)
  }
}

async function assertSameBranch(repo: string, branch: string | null, git: Pick<BranchGit, "repoStatus">) {
  const current = await git.repoStatus(repo)
  if (current.branch !== branch || current.operation) throw new BranchWorkflowError("branchChanged")
  return current
}

/** Desktop Dispatcher.cherryPick checks local edits before switching branches.
 * Both request drops and the history action use this same protection.
 */
export async function cherryPickToBranch(
  repo: string,
  branch: string,
  shas: string[],
  git: BranchGit & { cherryPick(repo: string, shas: string[]): Promise<unknown> },
  confirmStash: (target: string, current: string) => Promise<boolean>
) {
  if (shas.length === 0) return
  const before = await git.repoStatus(repo)
  if (before.operation) throw new BranchWorkflowError("operationInProgress")
  if (!before.branch) throw new BranchWorkflowError("detached")
  if (branch === before.branch) return
  if (before.changes.length > 0) {
    if (!(await confirmStash(branch, before.branch))) return
    await assertSameBranch(repo, before.branch, git)
    await git.stashPush(repo, before.branch)
  }
  await git.checkout(repo, branch)
  await git.cherryPick(repo, shas)
}

interface PushGit extends Pick<BranchGit, "repoStatus"> {
  branchDetails(repo: string, pattern: string): Promise<BranchDetails[]>
  pull(repo: string, remote: string): Promise<unknown>
  push(repo: string, remote: string, branch: string, remoteBranch: string | null, force: boolean): Promise<unknown>
}

/** Recovery runs inside the original operation. Never turn a generic rejection
 * (protected branch, hook, permissions) into an offer to force-push.
 */
export async function pushWithRecovery(
  repo: string,
  force: boolean,
  git: PushGit,
  confirmPull: () => Promise<boolean>,
  confirmForce?: () => Promise<boolean>
) {
  const status = await git.repoStatus(repo)
  if (!status.branch) throw new BranchWorkflowError("detached")
  if (status.operation) throw new BranchWorkflowError("operationInProgress")
  const branch = status.branch
  if (force && confirmForce) {
    if (!(await confirmForce())) return
    await assertSameBranch(repo, branch, git)
  }
  const details = (await git.branchDetails(repo, `refs/heads/${branch}`))[0]
  // Desktop `performPush` pushes to `branch.upstreamRemoteName || remote.name`, deriving the remote from
  // `%(upstream:short)`. A local upstream (`branch.<name>.remote = .`) has no remote prefix there, so Desktop pushes
  // the branch to the current remote under its own name; pushing to "." would move the local upstream instead.
  const localUpstream = details?.upstreamRemoteName === "."
  const remote = (localUpstream ? null : details?.upstreamRemoteName) ?? status.remote
  // Without any remote Desktop offers to publish the repository rather than push; a bare "origin" would be a relative
  // path Git accepts as a destination.
  if (!remote) throw new BranchWorkflowError("noUpstream")
  const remoteBranch =
    !localUpstream && details?.upstreamWithoutRemote ? `refs/heads/${details.upstreamWithoutRemote}` : null
  try {
    await git.push(repo, remote, branch, remoteBranch, force)
  } catch (error) {
    if (force || !/fetch first|behind its remote|non-fast-forward/i.test(String(error))) throw error
    if (!(await confirmPull())) throw error
    await assertSameBranch(repo, branch, git)
    await git.pull(repo, remote)
    await assertSameBranch(repo, branch, git)
    await git.push(repo, remote, branch, remoteBranch, false)
  }
}
