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

export enum PopupType {
  RenameBranch = "RenameBranch",
  DeleteBranch = "DeleteBranch",
  DeleteRemoteBranch = "DeleteRemoteBranch",
  ConfirmDiscardChanges = "ConfirmDiscardChanges",
  Preferences = "Preferences",
  RepositorySettings = "RepositorySettings",
  AddRepository = "AddRepository",
  CreateRepository = "CreateRepository",
  CloneRepository = "CloneRepository",
  CreateBranch = "CreateBranch",
  SignIn = "SignIn",
  About = "About",
  InstallGit = "InstallGit",
  PublishRepository = "PublishRepository",
  Acknowledgements = "Acknowledgements",
  UntrustedCertificate = "UntrustedCertificate",
  RemoveRepository = "RemoveRepository",
  TermsAndConditions = "TermsAndConditions",
  PushBranchCommits = "PushBranchCommits",
  CLIInstalled = "CLIInstalled",
  GenericGitAuthentication = "GenericGitAuthentication",
  ExternalEditorFailed = "ExternalEditorFailed",

  OpenWithExternalEditor = "OpenWithExternalEditor",
  OpenShellFailed = "OpenShellFailed",
  InitializeLFS = "InitializeLFS",
  LFSAttributeMismatch = "LFSAttributeMismatch",
  UpstreamAlreadyExists = "UpstreamAlreadyExists",
  ReleaseNotes = "ReleaseNotes",
  DeletePullRequest = "DeletePullRequest",
  OversizedFiles = "OversizedFiles",
  CommitConflictsWarning = "CommitConflictsWarning",
  PushNeedsPull = "PushNeedsPull",
  ConfirmForcePush = "ConfirmForcePush",
  StashAndSwitchBranch = "StashAndSwitchBranch",
  ConfirmOverwriteStash = "ConfirmOverwriteStash",
  ConfirmDiscardStash = "ConfirmDiscardStash",
  ConfirmCheckoutCommit = "ConfirmCheckoutCommit",
  CreateTutorialRepository = "CreateTutorialRepository",
  ConfirmExitTutorial = "ConfirmExitTutorial",
  PushRejectedDueToMissingWorkflowScope = "PushRejectedDueToMissingWorkflowScope",
  SAMLReauthRequired = "SAMLReauthRequired",
  CreateFork = "CreateFork",
  CreateTag = "CreateTag",
  DeleteTag = "DeleteTag",
  LocalChangesOverwritten = "LocalChangesOverwritten",
  ChooseForkSettings = "ChooseForkSettings",
  ConfirmDiscardSelection = "ConfirmDiscardSelection",
  MoveToApplicationsFolder = "MoveToApplicationsFolder",
  ChangeRepositoryAlias = "ChangeRepositoryAlias",
  ThankYou = "ThankYou",
  CommitMessage = "CommitMessage",
  MultiCommitOperation = "MultiCommitOperation",
  WarnLocalChangesBeforeUndo = "WarnLocalChangesBeforeUndo",
  WarningBeforeReset = "WarningBeforeReset",
  InvalidatedToken = "InvalidatedToken",
  AddSSHHost = "AddSSHHost",
  SSHKeyPassphrase = "SSHKeyPassphrase",
  SSHUserPassword = "SSHUserPassword",
  PullRequestChecksFailed = "PullRequestChecksFailed",
  CICheckRunRerun = "CICheckRunRerun",
  WarnForcePush = "WarnForcePush",
  DiscardChangesRetry = "DiscardChangesRetry",
  PullRequestReview = "PullRequestReview",
  UnreachableCommits = "UnreachableCommits",
  StartPullRequest = "StartPullRequest",
  Error = "Error",
  InstallingUpdate = "InstallingUpdate",
  TestNotifications = "TestNotifications",
  PullRequestComment = "PullRequestComment",
  UnknownAuthors = "UnknownAuthors",
  TestIcons = "TestIcons",
  ConfirmCommitFilteredChanges = "ConfirmCommitFilteredChanges",
  TestAbout = "TestAbout",
  TestCLIAction = "TestCLIAction",

  TestTokenExpiration = "TestTokenExpiration",
  PushProtectionError = "PushProtectionError",
  BypassPushProtection = "BypassPushProtection",

  HookFailed = "HookFailed",
  CommitProgress = "CommitProgress",
  AddWorktree = "AddWorktree",
  RenameWorktree = "RenameWorktree",
  DeleteWorktree = "DeleteWorktree",

  DeleteWorktreeFailed = "DeleteWorktreeFailed"
}

interface IBasePopup {
  /**
   * Unique id of the popup that it receives upon adding to the stack.
   */
  readonly id?: number
}

export type PopupDetail =
  | { type: PopupType.RenameBranch; repository: Repository; branch: Branch }
  | {
      type: PopupType.DeleteBranch
      repository: Repository
      branch: Branch
      existsOnRemote: boolean
    }
  | {
      type: PopupType.DeleteRemoteBranch
      repository: Repository
      branch: Branch
    }
  | {
      type: PopupType.ConfirmDiscardChanges
      repository: Repository
      files: ReadonlyArray<WorkingDirectoryFileChange>
      showDiscardChangesSetting?: boolean
      discardingAllChanges?: boolean
    }
  | {
      type: PopupType.ConfirmDiscardSelection
      repository: Repository
      file: WorkingDirectoryFileChange
      diff: ITextDiff
      selection: DiffSelection
    }
  | { type: PopupType.Preferences; initialSelectedTab?: PreferencesTab }
  | {
      type: PopupType.RepositorySettings
      repository: Repository
      initialSelectedTab?: RepositorySettingsTab
    }
  | { type: PopupType.AddRepository; path?: string }
  | { type: PopupType.CreateRepository; path?: string }
  | {
      type: PopupType.CloneRepository
      initialURL: string | null
    }
  | {
      type: PopupType.CreateBranch
      repository: Repository
      initialName?: string
      targetCommit?: CommitOneLine
    }
  | {
      type: PopupType.SignIn
      isCredentialHelperSignIn?: boolean
      credentialHelperUrl?: string
    }
  | { type: PopupType.About }
  | { type: PopupType.InstallGit; path: string }
  | { type: PopupType.PublishRepository; repository: Repository }
  | { type: PopupType.Acknowledgements }
  | {
      type: PopupType.UntrustedCertificate
      certificate: import("./certificate").Certificate
      url: string
    }
  | { type: PopupType.RemoveRepository; repository: Repository }
  | { type: PopupType.TermsAndConditions }
  | {
      type: PopupType.PushBranchCommits
      repository: Repository
      branch: Branch
      unPushedCommits?: number
    }
  | { type: PopupType.CLIInstalled }
  | {
      type: PopupType.GenericGitAuthentication
      remoteUrl: string
      username?: string
      onSubmit: (username: string, password: string) => void
      onDismiss: () => void
    }
  | { type: PopupType.OpenWithExternalEditor }
  | {
      type: PopupType.ExternalEditorFailed
      message: string
      suggestDefaultEditor?: boolean
      openPreferences?: boolean
    }
  | { type: PopupType.OpenShellFailed; message: string }
  | { type: PopupType.InitializeLFS; repositories: ReadonlyArray<Repository> }
  | { type: PopupType.LFSAttributeMismatch }
  | {
      type: PopupType.UpstreamAlreadyExists
      repository: Repository
      existingRemote: IRemote
    }
  | {
      type: PopupType.ReleaseNotes
      newReleases: ReadonlyArray<ReleaseSummary>
    }
  | {
      type: PopupType.DeletePullRequest
      repository: Repository
      branch: Branch
      pullRequest: PullRequest
    }
  | {
      type: PopupType.OversizedFiles
      oversizedFiles: ReadonlyArray<string>
      context: ICommitContext
      repository: Repository
    }
  | {
      type: PopupType.CommitConflictsWarning
      /** files that were selected for committing that are also conflicted */
      files: ReadonlyArray<WorkingDirectoryFileChange>
      /** repository user is committing in */
      repository: Repository
      /** information for completing the commit */
      context: ICommitContext
    }
  | {
      type: PopupType.PushNeedsPull
      repository: Repository
    }
  | {
      type: PopupType.ConfirmForcePush
      repository: Repository
      upstreamBranch: string
    }
  | {
      type: PopupType.StashAndSwitchBranch
      repository: Repository
      branchToCheckout: Branch
    }
  | {
      type: PopupType.ConfirmOverwriteStash
      repository: Repository
      branchToCheckout: Branch | null
    }
  | {
      type: PopupType.ConfirmDiscardStash
      repository: Repository
      stash: IStashEntry
    }
  | {
      type: PopupType.ConfirmCheckoutCommit
      repository: Repository
      commit: CommitOneLine
    }
  | {
      type: PopupType.CreateTutorialRepository
      account: Account
      progress?: Progress
    }
  | {
      type: PopupType.ConfirmExitTutorial
    }
  | {
      type: PopupType.PushRejectedDueToMissingWorkflowScope
      rejectedPath: string
      repository: RepositoryWithGitHubRepository
    }
  | {
      type: PopupType.SAMLReauthRequired
      organizationName: string
      endpoint: string
      retryAction?: RetryAction
    }
  | {
      type: PopupType.CreateFork
      repository: RepositoryWithGitHubRepository
      account: Account
    }
  | {
      type: PopupType.CreateTag
      repository: Repository
      targetCommitSha: string
      initialName?: string
      localTags: Map<string, string> | null
    }
  | {
      type: PopupType.DeleteTag
      repository: Repository
      tagName: string
    }
  | {
      type: PopupType.ChooseForkSettings
      repository: RepositoryWithForkedGitHubRepository
    }
  | {
      type: PopupType.LocalChangesOverwritten
      repository: Repository
      retryAction: RetryAction
      files: ReadonlyArray<string>
    }
  | { type: PopupType.MoveToApplicationsFolder }
  | { type: PopupType.ChangeRepositoryAlias; repository: Repository }
  | {
      type: PopupType.ThankYou
      userContributions: ReadonlyArray<ReleaseNote>
      friendlyName: string
      latestVersion: string | null
    }
  | {
      type: PopupType.CommitMessage
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
      type: PopupType.MultiCommitOperation
      repository: Repository
    }
  | {
      type: PopupType.WarnLocalChangesBeforeUndo
      repository: Repository
      commit: Commit
      isWorkingDirectoryClean: boolean
    }
  | {
      type: PopupType.WarningBeforeReset
      repository: Repository
      commit: Commit
    }
  | {
      type: PopupType.InvalidatedToken
      account: Account
    }
  | {
      type: PopupType.AddSSHHost
      host: string
      ip: string
      keyType: string
      fingerprint: string
      onSubmit: (addHost: boolean) => void
    }
  | {
      type: PopupType.SSHKeyPassphrase
      keyPath: string
      onSubmit: (passphrase: string | undefined, storePassphrase: boolean) => void
    }
  | {
      type: PopupType.SSHUserPassword
      username: string
      onSubmit: (password: string | undefined, storePassword: boolean) => void
    }
  | {
      type: PopupType.PullRequestChecksFailed
      repository: RepositoryWithGitHubRepository
      pullRequest: PullRequest
      shouldChangeRepository: boolean
      checks: ReadonlyArray<IRefCheck>
    }
  | {
      type: PopupType.CICheckRunRerun
      checkRuns: ReadonlyArray<IRefCheck>
      repository: GitHubRepository
      prRef: string
      failedOnly: boolean
    }
  | { type: PopupType.WarnForcePush; operation: string; onBegin: () => void }
  | {
      type: PopupType.DiscardChangesRetry
      retryAction: RetryAction
    }
  | {
      type: PopupType.PullRequestReview
      repository: RepositoryWithGitHubRepository
      pullRequest: PullRequest
      review: ValidNotificationPullRequestReview
      shouldCheckoutBranch: boolean
      shouldChangeRepository: boolean
    }
  | {
      type: PopupType.UnreachableCommits
      selectedTab: UnreachableCommitsTab
    }
  | {
      type: PopupType.StartPullRequest
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
      type: PopupType.Error
      error: Error
    }
  | {
      type: PopupType.InstallingUpdate
    }
  | {
      type: PopupType.TestNotifications
      repository: RepositoryWithGitHubRepository
    }
  | {
      type: PopupType.PullRequestComment
      repository: RepositoryWithGitHubRepository
      pullRequest: PullRequest
      comment: IAPIComment
      shouldCheckoutBranch: boolean
      shouldChangeRepository: boolean
    }
  | {
      type: PopupType.UnknownAuthors
      authors: ReadonlyArray<UnknownAuthor>
      onCommit: () => void
    }
  | {
      type: PopupType.TestIcons
    }
  | {
      type: PopupType.ConfirmCommitFilteredChanges
      onCommitAnyway: () => void
      showFilesToBeCommitted: () => void
    }
  | {
      type: PopupType.TestAbout
    }
  | {
      type: PopupType.TestCLIAction
    }
  | {
      type: PopupType.TestTokenExpiration
    }
  | {
      type: PopupType.PushProtectionError
      secrets: ReadonlyArray<ISecretScanResult>
    }
  | {
      type: PopupType.BypassPushProtection
      secret: ISecretScanResult
      bypassPushProtection: (secret: ISecretScanResult, reason: BypassReasonType) => void
      onDismissed: () => void
    }
  | {
      type: PopupType.HookFailed
      hookName: string
      terminalOutput: TerminalOutput
      resolve: (value: "abort" | "ignore") => void
    }
  | {
      type: PopupType.CommitProgress
      subscribeToCommitOutput: TerminalOutputListener
    }
  | {
      type: PopupType.AddWorktree
      repository: Repository
      initialBranchName?: string
      initialWorktreeName?: string
    }
  | {
      type: PopupType.RenameWorktree
      repository: Repository
      worktreePath: string
    }
  | {
      type: PopupType.DeleteWorktree
      repository: Repository
      worktreePath: string
      options: IDeleteWorktreeOptions
    }
  | {
      type: PopupType.DeleteWorktreeFailed
      repository: Repository
      worktreePath: string
      error: Error
      originalWorktree: WorktreeEntry | null
      options: IDeleteWorktreeOptions
    }
export type Popup = IBasePopup & PopupDetail
