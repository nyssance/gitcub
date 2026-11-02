// Desktop MIT state contracts extracted from app-state.

import type { TerminalOutputListener } from "../lib/git-execution"
import type { Author } from "../upstream/models/author"
import type { CommitIdentity } from "../upstream/models/commit-identity"
import type { ICommitMessage } from "../upstream/models/commit-message"
import type { IDiff } from "../upstream/models/diff"
import type { ManualConflictResolution } from "../upstream/models/manual-conflict-resolution"
import type {
  ICheckoutProgress,
  IMultiCommitOperationProgress,
  IRevertProgress,
  Progress
} from "../upstream/models/progress"
import type { IRemote } from "../upstream/models/remote"
import type { RepoRulesInfo } from "../upstream/models/repo-rules"
import type { IStashEntry } from "../upstream/models/stash-entry"
import type { CommittedFileChange, WorkingDirectoryStatus } from "../upstream/models/status"
import type { Branch, IAheadBehind } from "./branch"
import type { IChangesetData } from "./changeset-data"
import type { Commit } from "./commit"
import type { HookProgress } from "./hook-progress"
import type { MergeTreeResult } from "./merge"
import type { MultiCommitOperationDetail, MultiCommitOperationStep } from "./multi-commit-operation"
import type { PullRequest } from "./pull-request"
import type { Tip } from "./tip"
import type { WorktreeEntry } from "./worktree"
export enum RepositorySectionTab {
  Changes,
  History
}

/**
 * Stores information about a merge conflict when it occurs
 */
export type MergeConflictState = {
  readonly kind: "merge"
  readonly currentBranch: string
  readonly currentTip: string
  readonly manualResolutions: Map<string, ManualConflictResolution>
}

/** Guard function for checking conflicts are from a merge  */
export function isMergeConflictState(conflictStatus: ConflictState): conflictStatus is MergeConflictState {
  return conflictStatus.kind === "merge"
}

/**
 * Stores information about a rebase conflict when it occurs
 */
export type RebaseConflictState = {
  readonly kind: "rebase"
  /**
   * This is the commit ID of the HEAD of the in-flight rebase
   */
  readonly currentTip: string
  /**
   * The branch chosen by the user to be rebased
   */
  readonly targetBranch: string
  /**
   * The branch chosen as the baseline for the rebase
   */
  readonly baseBranch?: string

  /**
   * The commit ID of the target branch before the rebase was initiated
   */
  readonly originalBranchTip: string
  /**
   * The commit ID of the base branch onto which the history will be applied
   */
  readonly baseBranchTip: string
  /**
   * Manual resolutions chosen by the user for conflicted files to be applied
   * before continuing the rebase.
   */
  readonly manualResolutions: Map<string, ManualConflictResolution>
}

/** Guard function for checking conflicts are from a rebase  */
export function isRebaseConflictState(conflictStatus: ConflictState): conflictStatus is RebaseConflictState {
  return conflictStatus.kind === "rebase"
}

/**
 * Conflicts can occur during a rebase, merge, or cherry pick.
 *
 * Callers should inspect the `kind` field to determine the kind of conflict
 * that is occurring, as this will then provide additional information specific
 * to the conflict, to help with resolving the issue.
 */
export type ConflictState = MergeConflictState | RebaseConflictState | CherryPickConflictState

export interface IRepositoryState {
  readonly commitSelection: ICommitSelection
  readonly changesState: IChangesState
  readonly compareState: ICompareState
  readonly selectedSection: RepositorySectionTab

  /**
   * The state of the current pull request view in the repository.
   *
   * It will be populated when a user initiates a pull request. It may have
   * content to retain a users pull request state if they navigate
   * away from the current pull request view and then back. It is returned
   * to null after a pull request has been opened.
   */
  readonly pullRequestState: IPullRequestState | null

  /**
   * The name and email that will be used for the author info
   * when committing barring any race where user.name/user.email is
   * updated between us reading it and a commit being made
   * (ie we don't currently use this value explicitly when committing)
   */
  readonly commitAuthor: CommitIdentity | null

  readonly branchesState: IBranchesState

  /** The worktrees associated with this repository. */
  readonly worktrees: ReadonlyArray<WorktreeEntry>

  /** The commits loaded, keyed by their full SHA. */
  readonly commitLookup: Map<string, Commit>

  /**
   * The ordered local commit SHAs. The commits themselves can be looked up in
   * `commitLookup.`
   */
  readonly localCommitSHAs: ReadonlyArray<string>

  /** The remote currently associated with the repository, if defined in the configuration */
  readonly remote: IRemote | null

  /** The state of the current branch in relation to its upstream. */
  readonly aheadBehind: IAheadBehind | null

  /** The tags that will get pushed if the user performs a push operation. */
  readonly tagsToPush: ReadonlyArray<string> | null

  /** Is a push/pull/fetch in progress? */
  readonly isPushPullFetchInProgress: boolean

  /** Is a commit in progress? */
  readonly isCommitting: boolean

  /** Is generating a commit message? */
  readonly isGeneratingCommitMessage: boolean

  /** Controller used to cancel an in-flight commit message generation. */

  /** Commit being amended, or null if none. */
  readonly commitToAmend: Commit | null

  /** The date the repository was last fetched. */
  readonly lastFetched: Date | null

  readonly hookProgress: HookProgress | null
  readonly subscribeToCommitOutput: TerminalOutputListener | null

  /**
   * If we're currently working on switching to a new branch this
   * provides insight into the progress of that operation.
   *
   * null if no current branch switch operation is in flight.
   */
  readonly checkoutProgress: ICheckoutProgress | null

  /**
   * If we're currently working on pushing a branch, fetching
   * from a remote or pulling a branch this provides insight
   * into the progress of that operation.
   *
   * null if no such operation is in flight.
   */
  readonly pushPullFetchProgress: Progress | null

  /**
   * If we're currently reverting a commit and it involves LFS progress, this
   * will contain the LFS progress.
   *
   * null if no such operation is in flight.
   */
  readonly revertProgress: IRevertProgress | null

  readonly localTags: Map<string, string> | null

  /** Undo state associated with a multi commit operation operation */
  readonly multiCommitOperationUndoState: IMultiCommitOperationUndoState | null

  /** State associated with a multi commit operation such as rebase,
   * cherry-pick, squash, reorder... */
  readonly multiCommitOperationState: IMultiCommitOperationState | null

  /**
   * Whether or not to skip blocking commit hooks when creating commits
   * by means of passing the `--no-verify` flag to git commit
   */
  readonly skipCommitHooks: boolean

  /**
   * Whether or not to add a `Signed-off-by` trailer to commit messages
   * by means of passing the `--signoff` flag to git commit
   */
  readonly signOffCommits: boolean

  /**
   * Whether or not to allow creating a commit without any file changes
   * by means of passing the `--allow-empty` flag to git commit.
   * This option resets to false after each commit.
   */
  readonly allowEmptyCommit: boolean
}

export type CommitOptions = Pick<IRepositoryState, "skipCommitHooks" | "signOffCommits" | "allowEmptyCommit">

export interface IBranchesState {
  /**
   * The current tip of HEAD, either a branch, a commit (if HEAD is
   * detached) or an unborn branch (a branch with no commits).
   */
  readonly tip: Tip

  /**
   * The default branch for a given repository. Historically it's been
   * common to use 'master' as the default branch but as of September 2020
   * GitHub Desktop and GitHub.com default to using 'main' as the default branch.
   *
   * GitHub Desktop users are able to configure the `init.defaultBranch` Git
   * setting in preferences.
   *
   * GitHub.com users are able to change their default branch in the web UI.
   */
  readonly defaultBranch: Branch | null

  /**
   * The default branch of the upstream remote in a forked GitHub repository
   * with the ForkContributionTarget.Parent behavior, or null if it cannot be
   * inferred or is another kind of repository.
   */
  readonly upstreamDefaultBranch: Branch | null

  /**
   * A list of all branches (remote and local) that's currently in
   * the repository.
   */
  readonly allBranches: ReadonlyArray<Branch>

  /**
   * A list of zero to a few (at time of writing 5 but check loadRecentBranches
   * in git-store for definitive answer) branches that have been checked out
   * recently. This list is compiled by reading the reflog and tracking branch
   * switches over the last couple of thousand reflog entries.
   */
  readonly recentBranches: ReadonlyArray<Branch>

  /** The open pull requests in the repository. */
  readonly openPullRequests: ReadonlyArray<PullRequest>

  /** Are we currently loading pull requests? */
  readonly isLoadingPullRequests: boolean

  /** The pull request associated with the current branch. */
  readonly currentPullRequest: PullRequest | null

  /**
   * Is the current branch configured to rebase on pull?
   *
   * This is the value returned from git config (local or global) for `git config pull.rebase`
   *
   * If this value is not found in config, this will be `undefined` to indicate
   * that the default Git behaviour will occur.
   */
  readonly pullWithRebase?: boolean

  /** Tracking branches that have been allowed to be force-pushed within Desktop */
  readonly forcePushBranches: ReadonlyMap<string, string>
}

export interface ICommitSelection {
  /** The commits currently selected in the app */
  readonly shas: ReadonlyArray<string>

  /**
   * When multiple commits are selected, the diff is created using the rev range
   * of firstSha^..lastSha in the selected shas. Thus comparing the trees of the
   * the lastSha and the first parent of the first sha. However, our history
   * list shows commits in chronological order. Thus, when a branch is merged,
   * the commits from that branch are injected in their chronological order into
   * the history list. Therefore, given a branch history of A, B, C, D,
   * MergeCommit where B and C are from the merged branch, diffing on the
   * selection of A through D would not have the changes from B an C.
   *
   * This is a list of the shas that are reachable by following the parent links
   * (aka the graph) from the lastSha to the firstSha^ in the selection.
   *
   * Other notes: Given a selection A through D, executing `git diff A..D` would
   * give us the changes since A but not including A; since the user will have
   * selected A, we do `git diff A^..D` so that we include the changes of A.
   * */
  readonly shasInDiff: ReadonlyArray<string>

  /**
   * Whether the a selection of commits are group of adjacent to each other.
   * Example: Given these are indexes of sha's in history, 3, 4, 5, 6 is contiguous as
   * opposed to 3, 5, 8.
   *
   * Technically order does not matter, but shas are stored in order.
   *
   * Contiguous selections can be diffed. Non-contiguous selections can be
   * cherry-picked, reordered, or squashed.
   *
   * Assumed that a selections of zero or one commit are contiguous.
   * */
  readonly isContiguous: boolean

  /** The changeset data associated with the selected commit */
  readonly changesetData: IChangesetData

  /** The selected file inside the selected commit */
  readonly file: CommittedFileChange | null

  /** The diff of the currently-selected file */
  readonly diff: IDiff | null
}

export enum ChangesSelectionKind {
  WorkingDirectory = "WorkingDirectory",
  Stash = "Stash"
}

export type ChangesWorkingDirectorySelection = {
  readonly kind: ChangesSelectionKind.WorkingDirectory

  /**
   * The ID of the selected files. The files themselves can be looked up in
   * the `workingDirectory` property in `IChangesState`.
   */
  readonly selectedFileIDs: ReadonlyArray<string>
  readonly diff: IDiff | null
}

export type ChangesStashSelection = {
  readonly kind: ChangesSelectionKind.Stash

  /** Currently selected file in the stash diff viewer UI (aka the file we want to show the diff for) */
  readonly selectedStashedFile: CommittedFileChange | null

  /** Currently selected file's diff */
  readonly selectedStashedFileDiff: IDiff | null
}

export type ChangesSelection = ChangesWorkingDirectorySelection | ChangesStashSelection

export interface IChangesState {
  readonly workingDirectory: WorkingDirectoryStatus

  /** The commit message for a work-in-progress commit in the changes view. */
  readonly commitMessage: ICommitMessage

  /**
   * Whether or not to show a field for adding co-authors to
   * a commit (currently only supported for GH/GHE repositories)
   */
  readonly showCoAuthoredBy: boolean

  /**
   * A list of authors (name, email pairs) which have been
   * entered into the co-authors input box in the commit form
   * and which _may_ be used in the subsequent commit to add
   * Co-Authored-By commit message trailers depending on whether
   * the user has chosen to do so.
   */
  readonly coAuthors: ReadonlyArray<Author>

  /**
   * Stores information about conflicts in the working directory
   *
   * The absence of a value means there is no merge or rebase conflict underway
   */
  readonly conflictState: ConflictState | null

  /**
   * The latest GitHub Desktop stash entry for the current branch, or `null`
   * if no stash exists for the current branch.
   */
  readonly stashEntry: IStashEntry | null

  /**
   * The current selection state in the Changes view. Can be either
   * working directory or a stash. In the case of a working directory
   * selection multiple files may be selected. See `ChangesSelection`
   * for more information about the differences between the two.
   */
  readonly selection: ChangesSelection

  /** `true` if the GitHub API reports that the branch is protected */
  readonly currentBranchProtected: boolean

  /**
   * Repo rules that apply to the current branch.
   */
  readonly currentRepoRulesInfo: RepoRulesInfo

  /** The file list filter state containing all filter options */
  readonly fileListFilter: IFileListFilterState
}

/**
 * State interface for file list filtering options
 */
export interface IFileListFilterState {
  /** The text entered into the filter text box */
  readonly filterText: string

  /** Whether to filter and show only included in commit files */
  readonly isIncludedInCommit: boolean

  /** Whether to filter and show only excluded from commit files */
  readonly isExcludedFromCommit: boolean

  /** Whether to filter and show only new files */
  readonly isNewFile: boolean

  /** Whether to filter and show only modified files */
  readonly isModifiedFile: boolean

  /** Whether to filter and show only deleted files */
  readonly isDeletedFile: boolean
}

/**
 * This represents the various states the History tab can be in.
 *
 * By default, it should show the history of the current branch.
 */
export enum HistoryTabMode {
  History = "History",
  Compare = "Compare"
}

/**
 * This represents whether the compare tab is currently viewing the
 * commits ahead or behind when merging some other branch into your
 * current branch.
 */
export enum ComparisonMode {
  Ahead = "Ahead",
  Behind = "Behind"
}

/**
 * The default comparison state is to display the history for the current
 * branch.
 */
export interface IDisplayHistory {
  readonly kind: HistoryTabMode.History
}

/**
 * When the user has chosen another branch to compare, using their current
 * branch as the base branch.
 */
export interface ICompareBranch {
  readonly kind: HistoryTabMode.Compare

  /** The chosen comparison mode determines which commits to show */
  readonly comparisonMode: ComparisonMode.Ahead | ComparisonMode.Behind

  /** The branch to compare against the base branch */
  readonly comparisonBranch: Branch

  /** The number of commits the selected branch is ahead/behind the current branch */
  readonly aheadBehind: IAheadBehind
}

export interface ICompareState {
  /** The current state of the compare form, based on user input */
  readonly formState: IDisplayHistory | ICompareBranch

  /** The result of merging the compare branch into the current branch, if a branch selected */
  readonly mergeStatus: MergeTreeResult | null

  /** Whether the branch list should be expanded or hidden */
  readonly showBranchList: boolean

  /** The text entered into the compare branch filter text box */
  readonly filterText: string

  /** The SHA associated with the most recent history state */
  readonly tip: string | null

  /** The SHAs of commits to render in the compare list */
  readonly commitSHAs: ReadonlyArray<string>

  /** The SHAs of commits to highlight in the compare list */
  readonly shasToHighlight: ReadonlyArray<string>

  /**
   * A list of branches (remote and local) except the current branch, and
   * Desktop fork remote branches (see `Branch.isDesktopForkRemoteBranch`)
   **/
  readonly branches: ReadonlyArray<Branch>

  /**
   * A list of zero to a few (at time of writing 5 but check loadRecentBranches
   * in git-store for definitive answer) branches that have been checked out
   * recently. This list is compiled by reading the reflog and tracking branch
   * switches over the last couple of thousand reflog entries.
   */
  readonly recentBranches: ReadonlyArray<Branch>

  /**
   * The default branch for a given repository. Historically it's been
   * common to use 'master' as the default branch but as of September 2020
   * GitHub Desktop and GitHub.com default to using 'main' as the default branch.
   *
   * GitHub Desktop users are able to configure the `init.defaultBranch` Git
   * setting in preferences.
   *
   * GitHub.com users are able to change their default branch in the web UI.
   */
  readonly defaultBranch: Branch | null
}

export interface ICompareFormUpdate {
  /** The updated filter text to set */
  readonly filterText: string

  /** Thew new state of the branches list */
  readonly showBranchList: boolean
}

export interface IViewHistory {
  readonly kind: HistoryTabMode.History
}

export interface ICompareToBranch {
  readonly kind: HistoryTabMode.Compare
  readonly branch: Branch
  readonly comparisonMode: ComparisonMode.Ahead | ComparisonMode.Behind
}

/**
 * An action to send to the application store to update the compare state
 */
export type CompareAction = IViewHistory | ICompareToBranch

/**
 * Undo state associated with a multi commit operation being performed on a
 * repository.
 */
export interface IMultiCommitOperationUndoState {
  /** The sha of the tip before operation was initiated. */
  readonly undoSha: string

  /** The name of the branch the operation applied to */
  readonly branchName: string
}

/**
 * Stores information about a cherry pick conflict when it occurs
 */
export type CherryPickConflictState = {
  readonly kind: "cherryPick"

  /**
   * Manual resolutions chosen by the user for conflicted files to be applied
   * before continuing the cherry pick.
   */
  readonly manualResolutions: Map<string, ManualConflictResolution>

  /**
   * The branch chosen by the user to copy the cherry picked commits to
   */
  readonly targetBranchName: string
}

/** Guard function for checking conflicts are from a rebase  */
export function isCherryPickConflictState(conflictStatus: ConflictState): conflictStatus is CherryPickConflictState {
  return conflictStatus.kind === "cherryPick"
}

/**
 * Tracks the state of the app during a multi commit operation such as rebase,
 * cherry-picking, and interactive rebase (squashing, reordering).
 */
export interface IMultiCommitOperationState {
  /**
   * The current step of the operation the user is at.
   * Examples: ChooseBranchStep, ChooseBranchStep, ShowConflictsStep, etc.
   */
  readonly step: MultiCommitOperationStep

  /**
   * This hold properties specific to the operation.
   */
  readonly operationDetail: MultiCommitOperationDetail
  /**
   * The underlying parsed Git information associated with the progress of the
   * current operation.
   *
   * Example: During cherry-picking, after each commit this progress will be
   * updated to reflect the next commit in the list to cherry-pick.
   */
  readonly progress: IMultiCommitOperationProgress

  /**
   * Whether the user has done work to resolve any conflicts as part of this
   * operation, and therefore, should be warned on aborting the operation.
   */
  readonly userHasResolvedConflicts: boolean

  /**
   * The commit id of the tip of the branch user is modifying in the operation.
   *
   * Uses:
   *  - Cherry-picking = tip of target branch before cherry-pick, used to undo cherry-pick
   *        - This maybe null if app opens mid cherry-pick
   *  - Rebasing = tip of current branch before rebase, used enable force pushing after rebase complete.
   *  - Interactive Rebasing (Squash, Reorder) = tip of current branch, used for force pushing and undoing
   */
  readonly originalBranchTip: string | null

  /**
   * The branch that is being modified during the operation.
   *
   * - Cherry-pick = the branch chosen to copy commits to; Maybe null when cherry-pick is in the choose branch step.
   * - Rebase = the current branch the user is on.
   * - Squash = the current branch the user is on.
   */
  readonly targetBranch: Branch | null
}

export type MultiCommitOperationConflictState = {
  readonly kind: "multiCommitOperation"

  /**
   * Manual resolutions chosen by the user for conflicted files to be applied
   * before continuing the operation
   */
  readonly manualResolutions: Map<string, ManualConflictResolution>

  /**
   * Depending on the operation, this may be either source branch or the
   * target branch.
   *
   * Also, we may not know what it is. This usually happens if Desktop is closed
   * during an operation and the reopened and we lose some context that is
   * stored in state.
   */
  readonly ourBranch?: string

  /**
   * Depending on the operation, this may be either source branch or the
   * target branch
   *
   * Also, we may not know what it is. This usually happens if Desktop is closed
   * during an operation and the reopened and we lose some context that is
   * stored in state.
   */
  readonly theirBranch?: string
}

/**
 * An interface for describing a desired value and a valid range
 *
 * Note that the value can be greater than `max` or less than `min`, it's
 * an indication of the desired value. The real value needs to be validated
 * or coerced using a function like `clamp`.
 *
 * Yeah this is a terrible name.
 */
export interface IConstrainedValue {
  readonly value: number
  readonly max: number
  readonly min: number
}

/**
 * The state of the current pull request view in the repository.
 */
export interface IPullRequestState {
  /**
   * The base branch of a a pull request - the branch the currently checked out
   * branch would merge into
   */
  readonly baseBranch: Branch | null

  /** The SHAs of commits of the pull request */
  readonly commitSHAs: ReadonlyArray<string> | null

  /**
   * The commit selection, file selection and diff of the pull request.
   *
   * Note: By default the commit selection shas will be all the pull request
   * shas and will mean the diff represents the merge base of the current branch
   * and the the pull request base branch. This is different than the
   * repositories commit selection where the diff of all commits represents the
   * diff between the latest commit and the earliest commits parent.
   */
  readonly commitSelection: ICommitSelection | null

  /** The result of merging the pull request branch into the base branch */
  readonly mergeStatus: MergeTreeResult | null
}
