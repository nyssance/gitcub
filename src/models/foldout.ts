// Desktop MIT implementation extracted unchanged from lib/app-state.ts.
export const FoldoutType = {
  Repository: 0,
  Branch: 1,
  AppMenu: 2,
  AddMenu: 3,
  PushPull: 4,
  Worktree: 5
} as const
export type FoldoutType = (typeof FoldoutType)[keyof typeof FoldoutType]

export type AppMenuFoldout = {
  type: typeof FoldoutType.AppMenu

  /**
   * Whether or not the application menu was opened with the Alt key, this
   * enables access key highlighting for applicable menu items as well as
   * keyboard navigation by pressing access keys.
   */
  enableAccessKeyNavigation: boolean
}

export type BranchFoldout = {
  type: typeof FoldoutType.Branch
}

export type Foldout =
  | { type: typeof FoldoutType.Repository }
  | { type: typeof FoldoutType.AddMenu }
  | BranchFoldout
  | AppMenuFoldout
  | { type: typeof FoldoutType.PushPull }
  | { type: typeof FoldoutType.Worktree }
