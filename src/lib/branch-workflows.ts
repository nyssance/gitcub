import type { BranchDetails, StashEntry } from "../models/app-state"
import type { RepoStatus } from "../models/repo-status"
import { UncommittedChangesStrategy } from "../upstream/models/uncommitted-changes-strategy"

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

/** Desktop 按分支只保留一份贮藏：留在当前分支要先找到并丢掉旧的，带走更改要找回刚建的那份 */
export interface StashGit extends BranchGit {
  lastBranchStash(repo: string, branch: string): Promise<StashEntry | null>
  dropStashSha(repo: string, sha: string): Promise<unknown>
  popStashSha(repo: string, sha: string): Promise<unknown>
}

const isLocalChangesOverwrittenError = (error: unknown) =>
  /would be overwritten|commit your changes or stash/i.test(String(error))

/** Desktop createStashAndDropPreviousEntry：先建新的，成功后再丢掉这个分支之前的那份 */
export async function createStashAndDropPreviousEntry(repo: string, branch: string, git: StashGit) {
  const previous = await git.lastBranchStash(repo, branch)
  await git.stashPush(repo, branch)
  if (previous) await git.dropStashSha(repo, previous.sha)
}

export interface CheckoutPrompts {
  /** Desktop StashAndSwitchBranch：`true` 留在当前分支，`"carry"` 带到新分支 */
  stashAndSwitch: (target: string, current: string, hasAssociatedStash: boolean) => Promise<boolean | "carry">
  /** Desktop ConfirmOverwriteStash：设置里选了「总是贮藏」而当前分支已有贮藏时 */
  overwriteStash: () => Promise<boolean>
}

/** Desktop AppStore._checkoutBranch + checkoutImplementation。调用方持有操作锁，这里不再取锁。
 *  - 有更改且策略是「每次询问」：先问更改放哪里（不再等 Git 拒绝后才问）
 *  - 「总是贮藏」且当前分支已有贮藏：先确认覆盖
 *  - 分离 HEAD / 未出生分支总是带走更改
 *  - 留在当前分支：贮藏并丢掉旧的那份再切换；带走：直接切换，被拦下就临时贮藏、切换、弹出
 */
export async function checkoutWithStash(
  repo: string,
  branch: string,
  git: StashGit,
  prompts: CheckoutPrompts,
  preferred: UncommittedChangesStrategy = UncommittedChangesStrategy.AskForConfirmation
) {
  const before = await git.repoStatus(repo)
  if (before.branch === branch) return
  const hasChanges = before.changes.length > 0
  const current = before.branch
  let strategy = current ? preferred : UncommittedChangesStrategy.MoveToNewBranch

  if (hasChanges && current) {
    if (strategy === UncommittedChangesStrategy.AskForConfirmation) {
      const stash = await git.lastBranchStash(repo, current)
      const choice = await prompts.stashAndSwitch(branch, current, stash !== null)
      if (!choice) return
      strategy =
        choice === "carry"
          ? UncommittedChangesStrategy.MoveToNewBranch
          : UncommittedChangesStrategy.StashOnCurrentBranch
      if (strategy === UncommittedChangesStrategy.StashOnCurrentBranch && stash && !(await prompts.overwriteStash()))
        return
    } else if (strategy === UncommittedChangesStrategy.StashOnCurrentBranch) {
      if ((await git.lastBranchStash(repo, current)) && !(await prompts.overwriteStash())) return
    }
    await assertSameBranch(repo, current, git)
  }

  if (strategy === UncommittedChangesStrategy.StashOnCurrentBranch) {
    if (hasChanges && current) await createStashAndDropPreviousEntry(repo, current, git)
    await git.checkout(repo, branch)
    return
  }
  try {
    await git.checkout(repo, branch)
  } catch (error) {
    if (strategy !== UncommittedChangesStrategy.MoveToNewBranch || !isLocalChangesOverwrittenError(error)) throw error
    // 临时贮藏记在目标分支名下，不会覆盖目标分支已有的那份
    await git.stashPush(repo, branch)
    const stash = await git.lastBranchStash(repo, branch)
    // 建不出贮藏多半是 assume-unchanged / skip-worktree：照原版把检出错误交给用户
    if (!stash) throw error
    await git.checkout(repo, branch)
    await git.popStashSha(repo, stash.sha)
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
