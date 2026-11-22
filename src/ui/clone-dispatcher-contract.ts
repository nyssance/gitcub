import type { FoldoutType } from "../models/foldout"
import type { CloneRepositoryOptions } from "../upstream/models/clone-options"
export interface Dispatcher {
  closeFoldout(type: FoldoutType): void
  clone(url: string, path: string, options: CloneRepositoryOptions): unknown
  showDotComSignInDialog(): void
  showEnterpriseSignInDialog(): void
  /** Keep the clone dialog's account choice in the host store. */
  changeCloneRepositoriesAccount?(account: import("../models/account").Account): void
}
