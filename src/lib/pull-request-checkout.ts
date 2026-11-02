import type { BranchDetails, Remote } from "../models/app-state"
import { forkPullRequestRemoteName } from "../upstream/models/remote"
import { type BranchGit, BranchWorkflowError, cherryPickToBranch } from "./branch-workflows"

export interface PullRequestSource {
  number: number
  owner: string
  cloneUrl: string
  branch: string
  target: Remote
}

interface CheckoutGit {
  parseRemote(url: string): Promise<Remote | null>
  remotes(repo: string): Promise<[string, string][]>
  branchDetails(repo: string): Promise<BranchDetails[]>
  addRemote(repo: string, name: string, url: string): Promise<unknown>
  fetch(repo: string, remote: string): Promise<unknown>
  createBranch(repo: string, name: string, startPoint?: string, noTrack?: boolean): Promise<unknown>
}

/** Desktop Dispatcher.startCherryPickWithPullRequest -> cherryPick (bebc062c).
 * Resolve the source branch, protect local edits, then checkout before applying
 * commits. Callers supply SHAs in oldest-first history order. No push is made.
 */
export async function cherryPickToPullRequest(
  repo: string,
  source: PullRequestSource,
  shas: string[],
  git: CheckoutGit & BranchGit & { cherryPick(repo: string, shas: string[]): Promise<unknown> },
  confirmStash: (branch: string, current: string) => Promise<boolean>,
  prefix: "pr" | "mr" = "pr"
): Promise<void> {
  if (shas.length === 0) return
  const before = await git.repoStatus(repo)
  if (before.operation) throw new BranchWorkflowError("operationInProgress")
  if (!before.branch) throw new BranchWorkflowError("detached")
  const branch = await findPullRequestBranch(repo, source, git, prefix)
  const current = await git.repoStatus(repo)
  if (current.branch !== before.branch) throw new BranchWorkflowError("branchChanged")
  await cherryPickToBranch(repo, branch, shas, git, confirmStash)
}

export function sameHostedRepository(left: Remote | null, right: Remote | null): boolean {
  return (
    !!left &&
    !!right &&
    ["host", "owner", "name"].every(
      key => left[key as keyof Remote].toLowerCase() === right[key as keyof Remote].toLowerCase()
    )
  )
}

/** Desktop AppStore._findPullRequestBranch (bebc062c), with IPC replacing GitStore.
 * GitLab uses the same source-project checkout and mr/ branch namespace.
 * Errors propagate to the app; checkout and its stash confirmation stay shared.
 */
export async function findPullRequestBranch(
  repo: string,
  source: PullRequestSource,
  git: CheckoutGit,
  prefix: "pr" | "mr" = "pr"
): Promise<string> {
  const remotes = await git.remotes(repo)
  const sourceIdentity = await git.parseRemote(source.cloneUrl)
  if (!sourceIdentity) throw new Error("Invalid pull request source URL")
  const identities = await Promise.all(remotes.map(([, url]) => git.parseRemote(url)))
  let remote = remotes.find((_, index) => sameHostedRepository(sourceIdentity, identities[index]))
  if (!remote) {
    const name = forkPullRequestRemoteName(source.owner)
    await git.addRemote(repo, name, source.cloneUrl)
    remote = [name, source.cloneUrl]
  }
  const remoteRef = `${remote[0]}/${source.branch}`
  let branches = await git.branchDetails(repo)
  const tracking = branches.find(b => !b.remote && b.upstream === remoteRef)
  if (tracking) return tracking.name
  const hasRemote = () => branches.some(b => b.remote && b.name === remoteRef)
  if (!hasRemote()) {
    await git.fetch(repo, remote[0])
    branches = await git.branchDetails(repo)
  }
  if (!hasRemote())
    throw new Error(
      `Couldn't find branch '${source.branch}' in remote '${remote[0]}'. The source branch or repository may have been deleted.`
    )
  const defaultRemote = remotes.find(([name]) => name === "origin") ?? remotes[0]
  const upstreamRemote = remotes.find(
    ([name], index) => name === "upstream" && sameHostedRepository(source.target, identities[index])
  )
  const isFork = remote[0] !== defaultRemote?.[0] && remote[0] !== upstreamRemote?.[0]
  if (isFork) {
    const name = `${prefix}/${source.number}`
    await git.createBranch(repo, name, remoteRef, false)
    return name
  }
  return remoteRef
}
