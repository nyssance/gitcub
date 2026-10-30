// Desktop MIT implementation extracted unchanged from lib/app-state.ts.
export enum FoldoutType {
  Repository,
  Branch,
  AppMenu,
  AddMenu,
  PushPull,
  Worktree
}

export type AppMenuFoldout = {
  type: FoldoutType.AppMenu

  /**
   * Whether or not the application menu was opened with the Alt key, this
   * enables access key highlighting for applicable menu items as well as
   * keyboard navigation by pressing access keys.
   */
  enableAccessKeyNavigation: boolean
}

export type BranchFoldout = {
  type: FoldoutType.Branch
}

export type Foldout =
  | { type: FoldoutType.Repository }
  | { type: FoldoutType.AddMenu }
  | BranchFoldout
  | AppMenuFoldout
  | { type: FoldoutType.PushPull }
  | { type: FoldoutType.Worktree }
