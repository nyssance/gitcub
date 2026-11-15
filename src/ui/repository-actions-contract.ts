import type { FoldoutType } from "../models/foldout"
import type { Popup } from "../models/popup"
import type { Repository } from "../models/repository"
export interface RepositoryActionsDispatcher {
  postError(error: unknown): void
  refreshRepository(repository: Repository): Promise<void>
  removeRepository(repository: Repository, moveToTrash: boolean): void
  relocateRepository(repository: Repository): void
  cloneAgain(url: string, path: string): Promise<void>
  addRepositories(paths: readonly string[]): Promise<readonly Repository[]>
  closeFoldout(type: FoldoutType): void
  selectRepository(repository: Repository): void
  recordAddExistingRepository(): void
  showPopup(popup: Popup): void
}
