// Desktop MIT port; platform imports adapted to Tauri.
import type { RowIndexPath } from "../upstream/ui/lib/list/list-row-index-path"
import type { Commit } from "./commit"
import type { GitHubRepository } from "./github-repository"

/**
 * This is a type is used in conjunction with the drag and drop manager to
 * store and specify the types of data that are being dragged
 *
 * Thus, using a `|` here would allow us to specify multiple types of data that
 * can be dragged.
 */
export type DragData = CommitDragData

export type CommitDragData = {
  type: typeof DragType.Commit
  commits: ReadonlyArray<Commit>
}

export const DragType = {
  Commit: 0
} as const
export type DragType = (typeof DragType)[keyof typeof DragType]

export type DragElement = {
  type: typeof DragType.Commit
  commit: Commit
  selectedCommits: ReadonlyArray<Commit>
  gitHubRepository: GitHubRepository | null
}

export const DropTargetType = {
  Branch: 0,
  Commit: 1,
  ListInsertionPoint: 2
} as const
export type DropTargetType = (typeof DropTargetType)[keyof typeof DropTargetType]

export const DropTargetSelector = {
  Branch: ".branches-list-item",
  PullRequest: ".pull-request-item",
  Commit: ".commit",
  ListInsertionPoint: ".list-insertion-point"
} as const
export type DropTargetSelector = (typeof DropTargetSelector)[keyof typeof DropTargetSelector]

export type BranchTarget = {
  type: typeof DropTargetType.Branch
  branchName: string
}

export type CommitTarget = {
  type: typeof DropTargetType.Commit
}

export type ListInsertionPointTarget = {
  type: typeof DropTargetType.ListInsertionPoint
  data: DragData
  index: RowIndexPath
}

/**
 * This is a type is used in conjunction with the drag and drop manager to
 * pass information about a drop target.
 */
export type DropTarget = BranchTarget | CommitTarget | ListInsertionPointTarget
