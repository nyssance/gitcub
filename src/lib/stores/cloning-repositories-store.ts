// Desktop MIT port; platform imports adapted to Tauri.
import { CloningRepository } from "../../models/cloning-repository"
import { type RetryAction, RetryActionType } from "../../models/retry-actions"
import { BaseStore } from "../../upstream/lib/stores/base-store"
import type { CloneOptions } from "../../upstream/models/clone-options"
import type { ICloneProgress } from "../../upstream/models/progress"
import { clone as cloneRepo } from "../clone"
import { ErrorWithMetadata } from "../error-with-metadata"

/** The store in charge of repository currently being cloned. */
export class CloningRepositoriesStore extends BaseStore {
  private readonly _repositories = [] as CloningRepository[]
  private readonly stateByID = new Map<number, ICloneProgress>()

  /**
   * Clone the repository at the URL to the path.
   *
   * Returns a {Promise} which resolves to whether the clone was successful.
   */
  public async clone(url: string, path: string, options: CloneOptions): Promise<boolean> {
    const repository = new CloningRepository(path, url)
    this._repositories.push(repository)

    const title = `Cloning into ${path}`

    this.stateByID.set(repository.id, { kind: "clone", title, value: 0 })
    this.emitUpdate()

    let success = true
    try {
      await cloneRepo(url, path, options, progress => {
        this.stateByID.set(repository.id, progress)
        this.emitUpdate()
      })
    } catch (caught) {
      let e = caught as Error
      success = false

      const retryAction: RetryAction = {
        type: RetryActionType.Clone,
        name: repository.name,
        url,
        path,
        options
      }
      e = new ErrorWithMetadata(e, { retryAction, repository })

      this.emitError(e)
    }

    this.remove(repository)

    return success
  }

  /** Get the repositories currently being cloned. */
  public get repositories(): ReadonlyArray<CloningRepository> {
    return [...this._repositories]
  }

  /** Get the state of the repository. */
  public getRepositoryState(repository: CloningRepository): ICloneProgress | null {
    return this.stateByID.get(repository.id) ?? null
  }

  /** Remove the repository. */
  public remove(repository: CloningRepository) {
    this.stateByID.delete(repository.id)

    const repoIndex = this._repositories.findIndex(r => r.id === repository.id)
    if (repoIndex !== -1) {
      this._repositories.splice(repoIndex, 1)
    }

    this.emitUpdate()
  }
}
