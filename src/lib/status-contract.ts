// Desktop MIT implementation extracted unchanged from lib/git/status.ts.
import type { IAheadBehind } from "../models/branch"
import type { RebaseInternalState } from "../models/rebase-state"
import type { WorkingDirectoryStatus } from "../upstream/models/status"
export interface IStatusResult {
  /** The name of the current branch */
  readonly currentBranch?: string

  /** The name of the current upstream branch */
  readonly currentUpstreamBranch?: string

  /** The SHA of the tip commit of the current branch */
  readonly currentTip?: string

  /** How many commits ahead and behind
   *  the `currentBranch` is compared to the `currentUpstreamBranch`
   */
  readonly branchAheadBehind?: IAheadBehind

  /** true if the repository exists at the given location */
  readonly exists: boolean

  /** true if repository is in a conflicted state */
  readonly mergeHeadFound: boolean

  /** true merge --squash operation started */
  readonly squashMsgFound: boolean

  /** details about the rebase operation, if found */
  readonly rebaseInternalState: RebaseInternalState | null

  /** true if repository is in cherry pick state */
  readonly isCherryPickingHeadFound: boolean

  /** the absolute path to the repository's working directory */
  readonly workingDirectory: WorkingDirectoryStatus

  /** whether conflicting files present on repository */
  readonly doConflictedFilesExist: boolean
}
