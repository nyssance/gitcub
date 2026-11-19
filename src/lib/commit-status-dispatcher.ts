// Desktop MIT: original CI dispatcher methods, with an explicit store dependency.
import type { Disposable } from "event-kit"

import type { GitHubRepository } from "../models/github-repository"
import type { Repository } from "../models/repository"
import type { ICombinedRefCheck } from "./ci-checks/ci-checks"
import type { CommitStatusStore, StatusCallBack } from "./stores/commit-status-store"
export class CommitStatusDispatcher {
  private readonly commitStatusStore: CommitStatusStore

  constructor(commitStatusStore: CommitStatusStore) {
    this.commitStatusStore = commitStatusStore
  }
  public tryGetCommitStatus(
    repository: GitHubRepository,
    localRepository: Repository,
    ref: string,
    branchName?: string
  ): ICombinedRefCheck | null {
    return this.commitStatusStore.tryGetStatus(repository, localRepository, ref, branchName)
  }

  /**
   * Subscribe to commit status updates for a particular ref.
   *
   * @param repository The GitHub repository to use when looking up commit status.
   * @param localRepository The local repository providing the account assignment.
   * @param ref        The commit ref (can be a SHA or a Git ref) for which to
   *                   fetch status.
   * @param callback   A callback which will be invoked whenever the
   *                   store updates a commit status for the given ref.
   * @param branchName If we want to retrieve action workflow checks with the
   *                   sub, we provide the branch name for it.
   */
  public subscribeToCommitStatus(
    repository: GitHubRepository,
    localRepository: Repository,
    ref: string,
    callback: StatusCallBack,
    branchName?: string
  ): Disposable {
    return this.commitStatusStore.subscribe(repository, localRepository, ref, callback, branchName)
  }
}
