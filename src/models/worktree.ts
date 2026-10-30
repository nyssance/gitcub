// Desktop MIT port; platform imports adapted to Tauri.
import * as Path from "../lib/platform-path"
import type { UncommittedChangesStrategy } from "../upstream/models/uncommitted-changes-strategy"
import type { Branch } from "./branch"
import { shortenSHA } from "./commit"

export type WorktreeType = "main" | "linked"

export type WorktreeEntry = {
  readonly path: string
  readonly head: string
  /** Full ref name (e.g. `refs/heads/main`), or `null` when HEAD is detached */
  readonly branch: string | null
  readonly isDetached: boolean
  readonly type: WorktreeType
  readonly isLocked: boolean
  readonly isPrunable: boolean
}

/** A checkout to run once the worktree holding its branch has been removed. */
export interface IDeferredCheckout {
  readonly branch: Branch
  readonly strategy?: UncommittedChangesStrategy
}

/**
 * How a worktree is to be removed. Carried through the confirmation and
 * failure dialogs so a retry keeps it.
 */
export interface IDeleteWorktreeOptions {
  readonly force?: boolean
  /** The worktree's folder was gone when removal was offered. */
  readonly isMissing?: boolean
  readonly checkout?: IDeferredCheckout
}

/** The display name for a worktree (the basename of its path). */
export function getWorktreeDisplayName(worktree: WorktreeEntry): string {
  return Path.basename(worktree.path)
}

/**
 * The display description for a worktree: its branch name (without the
 * `refs/heads/` prefix) or a shortened HEAD SHA when HEAD is detached.
 */
export function getWorktreeDescription(worktree: WorktreeEntry): string {
  return worktree.branch ? worktree.branch.replace(/^refs\/heads\//, "") : shortenSHA(worktree.head)
}

/** The accessible name for a worktree list row. */
export function getWorktreeAriaLabel(worktree: WorktreeEntry): string {
  const missing = worktree.isPrunable ? ", missing" : ""
  return `${getWorktreeDisplayName(worktree)}${missing}, ${getWorktreeDescription(worktree)}`
}
