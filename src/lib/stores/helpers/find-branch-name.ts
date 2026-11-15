// Desktop MIT port; platform imports adapted to Tauri.

import type { GitHubRepository } from "../../../models/github-repository"
import { type Tip, TipState } from "../../../models/tip"
import type { IRemote } from "../../../upstream/models/remote"
import { urlMatchesCloneURL } from "../../repository-matching"

/**
 * Function to determine which branch name to use when looking for branch
 * protection information.
 *
 * If the remote branch matches the current `githubRepository` associated with
 * the repository, this will be used. Otherwise we will fall back to using the
 * branch name as that's a reasonable approximation for what would happen if the
 * user tries to push the new branch.
 */
export function findRemoteBranchName(
  tip: Tip,
  remote: IRemote | null,
  gitHubRepository: GitHubRepository
): string | null {
  if (tip.kind !== TipState.Valid) {
    return null
  }

  if (
    tip.branch.upstreamWithoutRemote !== null &&
    remote !== null &&
    urlMatchesCloneURL(remote.url, gitHubRepository)
  ) {
    return tip.branch.upstreamWithoutRemote
  }

  return tip.branch.nameWithoutRemote
}
