// Desktop MIT port; platform imports adapted to Tauri.

import type { IAPIComment } from "../lib/api"
import type { IRefCheck } from "../lib/ci-checks/ci-checks"
import type { TerminalOutput, TerminalOutputListener } from "../lib/git-execution"
import type { ValidNotificationPullRequestReview } from "../lib/valid-notification-pull-request-review"
import type { Account } from "../models/account"
import type { Author, UnknownAuthor } from "../upstream/models/author"
import type { ICommitMessage } from "../upstream/models/commit-message"
import type { DiffSelection, ImageDiffType, ITextDiff } from "../upstream/models/diff"
import type { PreferencesTab } from "../upstream/models/preferences"
import type { Progress } from "../upstream/models/progress"
import type { ReleaseNote, ReleaseSummary } from "../upstream/models/release-notes"
import type { IRemote } from "../upstream/models/remote"
import type { IStashEntry } from "../upstream/models/stash-entry"
import type { WorkingDirectoryFileChange } from "../upstream/models/status"
import type { Branch } from "./branch"
import type { Commit, CommitOneLine, ICommitContext } from "./commit"
import type { GitHubRepository } from "./github-repository"
import type { PullRequest } from "./pull-request"
import type { Repository, RepositoryWithForkedGitHubRepository, RepositoryWithGitHubRepository } from "./repository"
import type { RepositorySettingsTab } from "./repository-settings-tab"
import type { RetryAction } from "./retry-actions"
import type { ISecretScanResult } from "./secret-scan-result"
import type { BypassReasonType } from "./secret-scanning"
import type { UnreachableCommitsTab } from "./unreachable-commits-tab"
import type { IDeleteWorktreeOptions, WorktreeEntry } from "./worktree"

export const PopupType = {
  RenameBranch: "RenameBranch",
  DeleteBranch: "DeleteBranch",
  DeleteRemoteBranch: "DeleteRemoteBranch",
  ConfirmDiscardChanges: "ConfirmDiscardChanges",
  Preferences: "Preferences",
  RepositorySettings: "RepositorySettings",
  AddRepository: "AddRepository",
  CreateRepository: "CreateRepository",
  CloneRepository: "CloneRepository",
  CreateBranch: "CreateBranch",
  SignIn: "SignIn",
  About: "About",
  InstallGit: "InstallGit",
  PublishRepository: "PublishRepository",
  Acknowledgements: "Acknowledgements",
  UntrustedCertificate: "UntrustedCertificate",
  RemoveRepository: "RemoveRepository",
  TermsAndConditions: "TermsAndConditions",
  PushBranchCommits: "PushBranchCommits",
  CLIInstalled: "CLIInstalled",
  GenericGitAuthentication: "GenericGitAuthentication",
  ExternalEditorFailed: "ExternalEditorFailed",
  OpenWithExternalEditor: "OpenWithExternalEditor",
  OpenShellFailed: "OpenShellFailed",
  InitializeLFS: "InitializeLFS",
  LFSAttributeMismatch: "LFSAttributeMismatch",
  UpstreamAlreadyExists: "UpstreamAlreadyExists",
  ReleaseNotes: "ReleaseNotes",
  DeletePullRequest: "DeletePullRequest",
  OversizedFiles: "OversizedFiles",
  CommitConflictsWarning: "CommitConflictsWarning",
  PushNeedsPull: "PushNeedsPull",
  ConfirmForcePush: "ConfirmForcePush",
  StashAndSwitchBranch: "StashAndSwitchBranch",
  ConfirmOverwriteStash: "ConfirmOverwriteStash",
  ConfirmDiscardStash: "ConfirmDiscardStash",
  ConfirmCheckoutCommit: "ConfirmCheckoutCommit",
  CreateTutorialRepository: "CreateTutorialRepository",
  ConfirmExitTutorial: "ConfirmExitTutorial",
  PushRejectedDueToMissingWorkflowScope: "PushRejectedDueToMissingWorkflowScope",
  SAMLReauthRequired: "SAMLReauthRequired",
  CreateFork: "CreateFork",
  CreateTag: "CreateTag",
  DeleteTag: "DeleteTag",
  LocalChangesOverwritten: "LocalChangesOverwritten",
  ChooseForkSettings: "ChooseForkSettings",
  ConfirmDiscardSelection: "ConfirmDiscardSelection",
  MoveToApplicationsFolder: "MoveToApplicationsFolder",
  ChangeRepositoryAlias: "ChangeRepositoryAlias",
  ThankYou: "ThankYou",
  CommitMessage: "CommitMessage",
  MultiCommitOperation: "MultiCommitOperation",
  WarnLocalChangesBeforeUndo: "WarnLocalChangesBeforeUndo",
  WarningBeforeReset: "WarningBeforeReset",
  InvalidatedToken: "InvalidatedToken",
  AddSSHHost: "AddSSHHost",
  SSHKeyPassphrase: "SSHKeyPassphrase",
  SSHUserPassword: "SSHUserPassword",
  PullRequestChecksFailed: "PullRequestChecksFailed",
  CICheckRunRerun: "CICheckRunRerun",
  WarnForcePush: "WarnForcePush",
  DiscardChangesRetry: "DiscardChangesRetry",
  PullRequestReview: "PullRequestReview",
  UnreachableCommits: "UnreachableCommits",
  StartPullRequest: "StartPullRequest",
  Error: "Error",
  InstallingUpdate: "InstallingUpdate",
  TestNotifications: "TestNotifications",
  PullRequestComment: "PullRequestComment",
  UnknownAuthors: "UnknownAuthors",
  TestIcons: "TestIcons",
  ConfirmCommitFilteredChanges: "ConfirmCommitFilteredChanges",
  TestAbout: "TestAbout",
  TestCLIAction: "TestCLIAction",
  TestTokenExpiration: "TestTokenExpiration",
  PushProtectionError: "PushProtectionError",
  BypassPushProtection: "BypassPushProtection",
  HookFailed: "HookFailed",
  CommitProgress: "CommitProgress",
  AddWorktree: "AddWorktree",
  RenameWorktree: "RenameWorktree",
  DeleteWorktree: "DeleteWorktree",
  DeleteWorktreeFailed: "DeleteWorktreeFailed"
} as const
export type PopupType = (typeof PopupType)[keyof typeof PopupType]

interface IBasePopup {
  /**
   * Unique id of the popup that it receives upon adding to the stack.
   */
  readonly id?: number
}

export type PopupDetail =
  | { type: typeof PopupType.RenameBranch; repository: Repository; branch: Branch }
  | {
      type: typeof PopupType.DeleteBranch
      repository: Repository
      branch: Branch
      existsOnRemote: boolean
    }
  | {
      type: typeof PopupType.DeleteRemoteBranch
      repository: Repository
      branch: Branch
    }
  | {
      type: typeof PopupType.ConfirmDiscardChanges
      repository: Repository
      files: ReadonlyArray<WorkingDirectoryFileChange>
      showDiscardChangesSetting?: boolean
      discardingAllChanges?: boolean
    }
  | {
      type: typeof PopupType.ConfirmDiscardSelection
      repository: Repository
      file: WorkingDirectoryFileChange
      diff: ITextDiff
      selection: DiffSelection
    }
  | { type: typeof PopupType.Preferences; initialSelectedTab?: PreferencesTab }
  | {
      type: typeof PopupType.RepositorySettings
      repository: Repository
      initialSelectedTab?: RepositorySettingsTab
    }
  | { type: typeof PopupType.AddRepository; path?: string }
  | { type: typeof PopupType.CreateRepository; path?: string }
  | {
      type: typeof PopupType.CloneRepository
      initialURL: string | null
    }
  | {
      type: typeof PopupType.CreateBranch
      repository: Repository
      initialName?: string
      targetCommit?: CommitOneLine
    }
  | {
      type: typeof PopupType.SignIn
      isCredentialHelperSignIn?: boolean
      credentialHelperUrl?: string
    }
  | { type: typeof PopupType.About }
  | { type: typeof PopupType.InstallGit; path: string }
  | { type: typeof PopupType.PublishRepository; repository: Repository }
  | { type: typeof PopupType.Acknowledgements }
  | {
      type: typeof PopupType.UntrustedCertificate
      certificate: import("./certificate").Certificate
      url: string
    }
  | { type: typeof PopupType.RemoveRepository; repository: Repository }
  | { type: typeof PopupType.TermsAndConditions }
  | {
      type: typeof PopupType.PushBranchCommits
      repository: Repository
      branch: Branch
      unPushedCommits?: number
    }
  | { type: typeof PopupType.CLIInstalled }
  | {
      type: typeof PopupType.GenericGitAuthentication
      remoteUrl: string
      username?: string
      onSubmit: (username: string, password: string) => void
      onDismiss: () => void
    }
  | { type: typeof PopupType.OpenWithExternalEditor }
  | {
      type: typeof PopupType.ExternalEditorFailed
      message: string
      suggestDefaultEditor?: boolean
      openPreferences?: boolean
    }
  | { type: typeof PopupType.OpenShellFailed; message: string }
  | { type: typeof PopupType.InitializeLFS; repositories: ReadonlyArray<Repository> }
  | { type: typeof PopupType.LFSAttributeMismatch }
  | {
      type: typeof PopupType.UpstreamAlreadyExists
      repository: Repository
      existingRemote: IRemote
    }
  | {
      type: typeof PopupType.ReleaseNotes
      newReleases: ReadonlyArray<ReleaseSummary>
    }
  | {
      type: typeof PopupType.DeletePullRequest
      repository: Repository
      branch: Branch
      pullRequest: PullRequest
    }
  | {
      type: typeof PopupType.OversizedFiles
      oversizedFiles: ReadonlyArray<string>
      context: ICommitContext
      repository: Repository
    }
  | {
      type: typeof PopupType.CommitConflictsWarning
      /** files that were selected for committing that are also conflicted */
      files: ReadonlyArray<WorkingDirectoryFileChange>
      /** repository user is committing in */
      repository: Repository
      /** information for completing the commit */
      context: ICommitContext
    }
  | {
      type: typeof PopupType.PushNeedsPull
      repository: Repository
    }
  | {
      type: typeof PopupType.ConfirmForcePush
      repository: Repository
      upstreamBranch: string
    }
  | {
      type: typeof PopupType.StashAndSwitchBranch
      repository: Repository
      branchToCheckout: Branch
    }
  | {
      type: typeof PopupType.ConfirmOverwriteStash
      repository: Repository
      branchToCheckout: Branch | null
    }
  | {
      type: typeof PopupType.ConfirmDiscardStash
      repository: Repository
      stash: IStashEntry
    }
  | {
      type: typeof PopupType.ConfirmCheckoutCommit
      repository: Repository
      commit: CommitOneLine
    }
  | {
      type: typeof PopupType.CreateTutorialRepository
      account: Account
      progress?: Progress
    }
  | {
      type: typeof PopupType.ConfirmExitTutorial
    }
  | {
      type: typeof PopupType.PushRejectedDueToMissingWorkflowScope
      rejectedPath: string
      repository: RepositoryWithGitHubRepository
    }
  | {
      type: typeof PopupType.SAMLReauthRequired
      organizationName: string
      endpoint: string
      retryAction?: RetryAction
    }
  | {
      type: typeof PopupType.CreateFork
      repository: RepositoryWithGitHubRepository
      account: Account
    }
  | {
      type: typeof PopupType.CreateTag
      repository: Repository
      targetCommitSha: string
      initialName?: string
      localTags: Map<string, string> | null
    }
  | {
      type: typeof PopupType.DeleteTag
      repository: Repository
      tagName: string
    }
  | {
      type: typeof PopupType.ChooseForkSettings
      repository: RepositoryWithForkedGitHubRepository
    }
  | {
      type: typeof PopupType.LocalChangesOverwritten
      repository: Repository
      retryAction: RetryAction
      files: ReadonlyArray<string>
    }
  | { type: typeof PopupType.MoveToApplicationsFolder }
  | { type: typeof PopupType.ChangeRepositoryAlias; repository: Repository }
  | {
      type: typeof PopupType.ThankYou
      userContributions: ReadonlyArray<ReleaseNote>
      friendlyName: string
      latestVersion: string | null
    }
  | {
      type: typeof PopupType.CommitMessage
      coAuthors: ReadonlyArray<Author>
      showCoAuthoredBy: boolean
      commitMessage: ICommitMessage | null
      dialogTitle: string
      dialogButtonText: string
      prepopulateCommitSummary: boolean
      repository: Repository
      onSubmitCommitMessage: (context: ICommitContext) => Promise<boolean>
    }
  | {
      type: typeof PopupType.MultiCommitOperation
      repository: Repository
    }
  | {
      type: typeof PopupType.WarnLocalChangesBeforeUndo
      repository: Repository
      commit: Commit
      isWorkingDirectoryClean: boolean
    }
  | {
      type: typeof PopupType.WarningBeforeReset
      repository: Repository
      commit: Commit
    }
  | {
      type: typeof PopupType.InvalidatedToken
      account: Account
    }
  | {
      type: typeof PopupType.AddSSHHost
      host: string
      ip: string
      keyType: string
      fingerprint: string
      onSubmit: (addHost: boolean) => void
    }
  | {
      type: typeof PopupType.SSHKeyPassphrase
      keyPath: string
      onSubmit: (passphrase: string | undefined, storePassphrase: boolean) => void
    }
  | {
      type: typeof PopupType.SSHUserPassword
      username: string
      onSubmit: (password: string | undefined, storePassword: boolean) => void
    }
  | {
      type: typeof PopupType.PullRequestChecksFailed
      repository: RepositoryWithGitHubRepository
      pullRequest: PullRequest
      shouldChangeRepository: boolean
      checks: ReadonlyArray<IRefCheck>
    }
  | {
      type: typeof PopupType.CICheckRunRerun
      checkRuns: ReadonlyArray<IRefCheck>
      repository: GitHubRepository
      prRef: string
      failedOnly: boolean
    }
  | { type: typeof PopupType.WarnForcePush; operation: string; onBegin: () => void }
  | {
      type: typeof PopupType.DiscardChangesRetry
      retryAction: RetryAction
    }
  | {
      type: typeof PopupType.PullRequestReview
      repository: RepositoryWithGitHubRepository
      pullRequest: PullRequest
      review: ValidNotificationPullRequestReview
      shouldCheckoutBranch: boolean
      shouldChangeRepository: boolean
    }
  | {
      type: typeof PopupType.UnreachableCommits
      selectedTab: UnreachableCommitsTab
    }
  | {
      type: typeof PopupType.StartPullRequest
      prBaseBranches: ReadonlyArray<Branch>
      currentBranch: Branch
      defaultBranch: Branch | null
      externalEditorLabel?: string
      imageDiffType: ImageDiffType
      prRecentBaseBranches: ReadonlyArray<Branch>
      repository: Repository
      nonLocalCommitSHA: string | null
      showSideBySideDiff: boolean
      currentBranchHasPullRequest: boolean
    }
  | {
      type: typeof PopupType.Error
      error: Error
    }
  | {
      type: typeof PopupType.InstallingUpdate
    }
  | {
      type: typeof PopupType.TestNotifications
      repository: RepositoryWithGitHubRepository
    }
  | {
      type: typeof PopupType.PullRequestComment
      repository: RepositoryWithGitHubRepository
      pullRequest: PullRequest
      comment: IAPIComment
      shouldCheckoutBranch: boolean
      shouldChangeRepository: boolean
    }
  | {
      type: typeof PopupType.UnknownAuthors
      authors: ReadonlyArray<UnknownAuthor>
      onCommit: () => void
    }
  | {
      type: typeof PopupType.TestIcons
    }
  | {
      type: typeof PopupType.ConfirmCommitFilteredChanges
      onCommitAnyway: () => void
      showFilesToBeCommitted: () => void
    }
  | {
      type: typeof PopupType.TestAbout
    }
  | {
      type: typeof PopupType.TestCLIAction
    }
  | {
      type: typeof PopupType.TestTokenExpiration
    }
  | {
      type: typeof PopupType.PushProtectionError
      secrets: ReadonlyArray<ISecretScanResult>
    }
  | {
      type: typeof PopupType.BypassPushProtection
      secret: ISecretScanResult
      bypassPushProtection: (secret: ISecretScanResult, reason: BypassReasonType) => void
      onDismissed: () => void
    }
  | {
      type: typeof PopupType.HookFailed
      hookName: string
      terminalOutput: TerminalOutput
      resolve: (value: "abort" | "ignore") => void
    }
  | {
      type: typeof PopupType.CommitProgress
      subscribeToCommitOutput: TerminalOutputListener
    }
  | {
      type: typeof PopupType.AddWorktree
      repository: Repository
      initialBranchName?: string
      initialWorktreeName?: string
    }
  | {
      type: typeof PopupType.RenameWorktree
      repository: Repository
      worktreePath: string
    }
  | {
      type: typeof PopupType.DeleteWorktree
      repository: Repository
      worktreePath: string
      options: IDeleteWorktreeOptions
    }
  | {
      type: typeof PopupType.DeleteWorktreeFailed
      repository: Repository
      worktreePath: string
      error: Error
      originalWorktree: WorktreeEntry | null
      options: IDeleteWorktreeOptions
    }
export type Popup = IBasePopup & PopupDetail
