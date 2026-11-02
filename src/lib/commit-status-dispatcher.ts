// Desktop MIT: original CI dispatcher methods, with an explicit store dependency.
import type { Disposable } from "event-kit"

import type { GitHubRepository } from "../models/github-repository"
import type { ICombinedRefCheck } from "./ci-checks/ci-checks"
import type { CommitStatusStore, StatusCallBack } from "./stores/commit-status-store"
export class CommitStatusDispatcher {
  constructor(private readonly commitStatusStore: CommitStatusStore) {}
  public tryGetCommitStatus(repository: GitHubRepository, ref: string, branchName?: string): ICombinedRefCheck | null {
    return this.commitStatusStore.tryGetStatus(repository, ref, branchName)
  }

  /**
   * Subscribe to commit status updates for a particular ref.
   *
   * @param repository The GitHub repository to use when looking up commit status.
   * @param ref        The commit ref (can be a SHA or a Git ref) for which to
   *                   fetch status.
   * @param callback   A callback which will be invoked whenever the
   *                   store updates a commit status for the given ref.
   * @param branchName If we want to retrieve action workflow checks with the
   *                   sub, we provide the branch name for it.
   */
  public subscribeToCommitStatus(
    repository: GitHubRepository,
    ref: string,
    callback: StatusCallBack,
    branchName?: string
  ): Disposable {
    return this.commitStatusStore.subscribe(repository, ref, callback, branchName)
  }
}
