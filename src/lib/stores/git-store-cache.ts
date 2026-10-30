// Desktop MIT port; platform imports adapted to Tauri.

import type { Repository } from "../../models/repository"
import type { IAppShell } from "../app-shell"
import type { IStatsStore } from "../stats/stats-contract"
import { GitStore } from "./git-store"

export class GitStoreCache {
  /** GitStores keyed by their hash. */
  private readonly gitStores = new Map<string, GitStore>()

  public constructor(
    private readonly shell: IAppShell,
    private readonly statsStore: IStatsStore,
    private readonly onGitStoreUpdated: (repository: Repository, gitStore: GitStore) => void,
    private readonly onDidError: (error: Error) => void
  ) {}

  public remove(repository: Repository) {
    if (this.gitStores.has(repository.hash)) {
      this.gitStores.delete(repository.hash)
    }
  }

  public get(repository: Repository): GitStore {
    let gitStore = this.gitStores.get(repository.hash)
    if (gitStore === undefined) {
      gitStore = new GitStore(repository, this.shell, this.statsStore)
      // Preserve the original Desktop implementation and contract.
      gitStore.onDidUpdate(() => this.onGitStoreUpdated(repository, gitStore!))
      gitStore.onDidError(error => this.onDidError(error))

      this.gitStores.set(repository.hash, gitStore)
    }

    return gitStore
  }
}
