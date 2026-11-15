// Desktop MIT port; platform imports adapted to Tauri.

import type { CloneOptions } from "../upstream/models/clone-options"
import type { IStashEntry } from "../upstream/models/stash-entry"
import type { WorkingDirectoryFileChange } from "../upstream/models/status"
import type { Branch } from "./branch"
import type { Commit, CommitOneLine, ICommitContext } from "./commit"
import type { Repository } from "./repository"

/** The types of actions that can be retried. */
export const RetryActionType = {
  Push: 1,
  Pull: 2,
  Fetch: 3,
  Clone: 4,
  Checkout: 5,
  Merge: 6,
  Rebase: 7,
  CherryPick: 8,
  CreateBranchForCherryPick: 9,
  Squash: 10,
  Reorder: 11,
  DiscardChanges: 12,
  PopStash: 13
} as const
export type RetryActionType = (typeof RetryActionType)[keyof typeof RetryActionType]

/** The retriable actions and their associated data. */
export type RetryAction =
  | { type: typeof RetryActionType.Push; repository: Repository }
  | { type: typeof RetryActionType.Pull; repository: Repository }
  | { type: typeof RetryActionType.Fetch; repository: Repository }
  | {
      type: typeof RetryActionType.Clone
      name: string
      url: string
      path: string
      options: CloneOptions
    }
  | {
      type: typeof RetryActionType.Checkout
      repository: Repository
      branch: Branch
    }
  | {
      type: typeof RetryActionType.Merge
      repository: Repository
      currentBranch: string
      theirBranch: Branch
    }
  | {
      type: typeof RetryActionType.Rebase
      repository: Repository
      baseBranch: Branch
      targetBranch: Branch
    }
  | {
      type: typeof RetryActionType.CherryPick
      repository: Repository
      targetBranch: Branch
      commits: ReadonlyArray<CommitOneLine>
      sourceBranch: Branch | null
    }
  | {
      type: typeof RetryActionType.CreateBranchForCherryPick
      repository: Repository
      targetBranchName: string
      startPoint: string | null
      noTrackOption: boolean
      commits: ReadonlyArray<CommitOneLine>
      sourceBranch: Branch | null
    }
  | {
      type: typeof RetryActionType.Squash
      repository: Repository
      toSquash: ReadonlyArray<Commit>
      squashOnto: Commit
      lastRetainedCommitRef: string | null
      commitContext: ICommitContext
    }
  | {
      type: typeof RetryActionType.Reorder
      repository: Repository
      commitsToReorder: ReadonlyArray<Commit>
      beforeCommit: Commit | null
      lastRetainedCommitRef: string | null
    }
  | {
      type: typeof RetryActionType.DiscardChanges
      repository: Repository
      files: ReadonlyArray<WorkingDirectoryFileChange>
    }
  | {
      type: typeof RetryActionType.PopStash
      repository: Repository
      stashEntry: IStashEntry
    }
