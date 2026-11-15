// Desktop MIT port; platform imports adapted to Tauri.
import type { ComputedAction } from "./computed-action"

interface IBlobResult {
  readonly mode: string
  readonly sha: string
  readonly path: string
}

export interface IMergeTreeEntry {
  readonly context: string
  readonly base?: IBlobResult
  readonly result?: IBlobResult
  readonly our?: IBlobResult
  readonly their?: IBlobResult
  readonly diff: string
  readonly hasConflicts?: boolean
}

export type MergeTreeSuccess = {
  readonly kind: typeof ComputedAction.Clean
}

export type MergeTreeError = {
  readonly kind: typeof ComputedAction.Conflicts
  readonly conflictedFiles: number
}

export type MergeTreeUnsupported = {
  readonly kind: typeof ComputedAction.Invalid
}

export type MergeTreeLoading = {
  readonly kind: typeof ComputedAction.Loading
}

export type MergeTreeResult = MergeTreeSuccess | MergeTreeError | MergeTreeUnsupported | MergeTreeLoading
