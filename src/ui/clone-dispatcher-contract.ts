import type { FoldoutType } from "../models/foldout"
export interface Dispatcher {
  closeFoldout(type: FoldoutType): void
  clone(url: string, path: string, options: { defaultBranch?: string }): unknown
  showDotComSignInDialog(): void
  showEnterpriseSignInDialog(): void
}
