// Desktop MIT port; platform imports adapted to Tauri.

import type { Branch } from "./branch"
import type { Commit, CommitOneLine, ICommitContext } from "./commit"
import type { MultiCommitOperationConflictState } from "./desktop-changes-state"
import type { GitHubRepository } from "./github-repository"
import type { IDetachedHead, IUnbornRepository, IValidBranch } from "./tip"

/**
 * Enum of types of multi commit operations
 *
 * Note: These are used to output the operation to the user
 * and as such should be capitalized.
 */
// Preserve the original Desktop implementation and contract.
export const MultiCommitOperationKind = {
  Rebase: "Rebase",
  CherryPick: "Cherry-pick",
  Squash: "Squash",
  Merge: "Merge",
  Reorder: "Reorder"
} as const
export type MultiCommitOperationKind = (typeof MultiCommitOperationKind)[keyof typeof MultiCommitOperationKind]

/** Type guard which narrows a string to a MultiCommitOperationKind */
export function isIdMultiCommitOperation(
  id: string
): id is
  | typeof MultiCommitOperationKind.Rebase
  | typeof MultiCommitOperationKind.CherryPick
  | typeof MultiCommitOperationKind.Squash
  | typeof MultiCommitOperationKind.Merge
  | typeof MultiCommitOperationKind.Reorder {
  return (
    id === MultiCommitOperationKind.Rebase ||
    id === MultiCommitOperationKind.CherryPick ||
    id === MultiCommitOperationKind.Squash ||
    id === MultiCommitOperationKind.Merge ||
    id === MultiCommitOperationKind.Reorder
  )
}

/**
 * Union type representing the possible states of an multi commit operation
 * such as rebase, interactive rebase, cherry-pick.
 */
export type MultiCommitOperationStep =
  | ChooseBranchStep
  | WarnForcePushStep
  | ShowProgressStep
  | ShowConflictsStep
  | HideConflictsStep
  | ConfirmAbortStep
  | CreateBranchStep

/**
 * Possible kinds of steps that may happen during a multi commit operation such
 * as rebase, interactive rebase, cherry-pick.
 */
// Preserve the original Desktop implementation and contract.
export const MultiCommitOperationStepKind = {
  ChooseBranch: "ChooseBranch",
  WarnForcePush: "WarnForcePush",
  ShowProgress: "ShowProgress",
  ShowConflicts: "ShowConflicts",
  HideConflicts: "HideConflicts",
  ConfirmAbort: "ConfirmAbort",
  CreateBranch: "CreateBranch"
} as const
export type MultiCommitOperationStepKind =
  (typeof MultiCommitOperationStepKind)[keyof typeof MultiCommitOperationStepKind]

export type ChooseBranchStep = {
  readonly kind: typeof MultiCommitOperationStepKind.ChooseBranch
  readonly defaultBranch: Branch | null
  readonly currentBranch: Branch
  readonly allBranches: ReadonlyArray<Branch>
  readonly recentBranches: ReadonlyArray<Branch>
  readonly initialBranch?: Branch
}

export type WarnForcePushStep = {
  readonly kind: typeof MultiCommitOperationStepKind.WarnForcePush
  readonly baseBranch: Branch
  readonly targetBranch: Branch
  readonly commits: ReadonlyArray<CommitOneLine>
}

export type ShowProgressStep = {
  readonly kind: typeof MultiCommitOperationStepKind.ShowProgress
}

export type ShowConflictsStep = {
  readonly kind: typeof MultiCommitOperationStepKind.ShowConflicts
  readonly conflictState: MultiCommitOperationConflictState
}

export type HideConflictsStep = {
  readonly kind: typeof MultiCommitOperationStepKind.HideConflicts
  readonly conflictState: MultiCommitOperationConflictState
}

export type ConfirmAbortStep = {
  readonly kind: typeof MultiCommitOperationStepKind.ConfirmAbort
  readonly conflictState: MultiCommitOperationConflictState
  /**
   * The step the user was on when they invoked the abort confirmation.
   * Used to route them back to the right place if they choose to
   * return rather than abort. Defaults to ShowConflicts if omitted
   * (the historical behavior).
   */
  readonly returnToStepKind?: typeof MultiCommitOperationStepKind.ShowConflicts
}

export type CreateBranchStep = {
  readonly kind: typeof MultiCommitOperationStepKind.CreateBranch
  allBranches: ReadonlyArray<Branch>
  defaultBranch: Branch | null
  upstreamDefaultBranch: Branch | null
  upstreamGhRepo: GitHubRepository | null
  tip: IUnbornRepository | IDetachedHead | IValidBranch
  targetBranchName: string
}

interface IBaseInteractiveRebaseDetails {
  /**
   * Array of commits used during the operation.
   */
  readonly commits: ReadonlyArray<Commit>

  /**
   * This is the commit sha of the HEAD of the in-flight operation used to compare
   * the state of the after an operation to a previous state.
   */
  readonly currentTip: string
}

interface IInteractiveRebaseDetails extends IBaseInteractiveRebaseDetails {
  /**
   * The reference to the last retained commit on the branch during an
   * interactive rebase or null if rebasing to the root.
   */
  readonly lastRetainedCommitRef: string | null
}

interface ISourceBranchDetails {
  /**
   * The branch that are the source of the commits for the operation.
   *
   * Cherry-pick = the branch the user started on.
   * Rebase, Merge = the branch the user picks in the choose branch dialog (thus will be null to start)
   */
  readonly sourceBranch: Branch | null
}

interface ISquashDetails extends IInteractiveRebaseDetails {
  readonly kind: typeof MultiCommitOperationKind.Squash

  /**
   * A commit that the interactive rebase takes place around.
   *
   * Example: Squashing all the 'commits' array onto the 'targetCommit'.
   */
  readonly targetCommit: Commit

  /**
   * The commit context of the commit squashed.
   */
  readonly commitContext: ICommitContext
}

interface IReorderDetails extends IInteractiveRebaseDetails {
  readonly kind: typeof MultiCommitOperationKind.Reorder

  /** The commit before which the commits to reorder will be placed. */
  readonly beforeCommit: Commit | null
}

interface ICherryPickDetails extends ISourceBranchDetails {
  readonly kind: typeof MultiCommitOperationKind.CherryPick
  /**
   * Whether a branch was created during operation.
   *
   * Example: can create a new branch to copy commits to during cherry-pick
   */
  readonly branchCreated: boolean

  /**
   * Array of commits used during the operation.
   */
  readonly commits: ReadonlyArray<CommitOneLine>
}

interface IRebaseDetails extends ISourceBranchDetails {
  readonly kind: typeof MultiCommitOperationKind.Rebase
  readonly commits: ReadonlyArray<CommitOneLine>
  /**
   * This is the commit sha of the HEAD of the in-flight operation used to compare
   * the state of the after an operation to a previous state.
   */
  readonly currentTip: string
}

interface IMergeDetails extends ISourceBranchDetails {
  readonly kind: typeof MultiCommitOperationKind.Merge
  readonly isSquash: boolean
}

export type MultiCommitOperationDetail =
  ISquashDetails | IReorderDetails | ICherryPickDetails | IRebaseDetails | IMergeDetails

// Preserve the original Desktop implementation and contract.
export function instanceOfIBaseRebaseDetails(object: unknown): object is IBaseInteractiveRebaseDetails {
  const objectWithRequiredFields: IBaseInteractiveRebaseDetails = {
    commits: [],
    currentTip: ""
  }

  return (
    typeof object === "object" && object !== null && Object.keys(objectWithRequiredFields).every(key => key in object)
  )
}

export const conflictSteps: readonly MultiCommitOperationStepKind[] = [MultiCommitOperationStepKind.ShowConflicts, MultiCommitOperationStepKind.ConfirmAbort]
