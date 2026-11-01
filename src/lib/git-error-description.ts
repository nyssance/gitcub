// Desktop MIT port of lib/git/core.ts isAuthFailureError 与 getDescriptionForError；文案走 i18n（gitErrors.*），
// 菜单提示换成本应用的「GitCub > 设置」。
import i18n from "@/lib/i18n"

import { DugiteError, parseBadConfigValueErrorInfo } from "./dugite-errors"

export function isAuthFailureError(
  error: DugiteError
): error is
  DugiteError.SSHAuthenticationFailed | DugiteError.SSHPermissionDenied | DugiteError.HTTPSAuthenticationFailed {
  switch (error) {
    case DugiteError.SSHAuthenticationFailed:
    case DugiteError.SSHPermissionDenied:
    case DugiteError.HTTPSAuthenticationFailed:
      return true
  }
  return false
}

export function getDescriptionForError(error: DugiteError, stderr: string): string | null {
  if (isAuthFailureError(error)) {
    return i18n.t("gitErrors.authenticationFailed", { menuHint: i18n.t("gitErrors.settingsMenuHint") })
  }

  switch (error) {
    case DugiteError.BadConfigValue: {
      const errorInfo = parseBadConfigValueErrorInfo(stderr)
      if (errorInfo === null) {
        return i18n.t("gitErrors.unsupportedGitConfigurationValue")
      }

      return i18n.t("gitErrors.unsupportedValueForGitConfigKey", { value: errorInfo.value, key: errorInfo.key })
    }
    case DugiteError.SSHKeyAuditUnverified:
      return i18n.t("gitErrors.theSshKeyIsUnverified")
    case DugiteError.RemoteDisconnection:
      return i18n.t("gitErrors.theRemoteDisconnected")
    case DugiteError.HostDown:
      return i18n.t("gitErrors.theHostIsDown")
    case DugiteError.RebaseConflicts:
      return i18n.t("gitErrors.weFoundSomeConflictsWhileTryingToRebase")
    case DugiteError.MergeConflicts:
      return i18n.t("gitErrors.weFoundSomeConflictsWhileTryingToMerge")
    case DugiteError.HTTPSRepositoryNotFound:
    case DugiteError.SSHRepositoryNotFound:
      return i18n.t("gitErrors.theRepositoryDoesNotSeemToExistAnymore")
    case DugiteError.PushNotFastForward:
      return i18n.t("gitErrors.theRepositoryHasBeenUpdatedSinceYouLastPulled")
    case DugiteError.BranchDeletionFailed:
      return i18n.t("gitErrors.couldNotDeleteTheBranch")
    case DugiteError.DefaultBranchDeletionFailed:
      return i18n.t("gitErrors.theBranchIsTheRepositorysDefaultBranch")
    case DugiteError.RevertConflicts:
      return i18n.t("gitErrors.toFinishRevertingPleaseMergeAndCommit")
    case DugiteError.EmptyRebasePatch:
      return i18n.t("gitErrors.thereArentAnyChangesLeftToApply")
    case DugiteError.NoMatchingRemoteBranch:
      return i18n.t("gitErrors.thereArentAnyRemoteBranchesThatMatch")
    case DugiteError.NothingToCommit:
      return i18n.t("gitErrors.thereAreNoChangesToCommit")
    case DugiteError.NoSubmoduleMapping:
      return i18n.t("gitErrors.aSubmoduleWasRemovedFromGitmodules")
    case DugiteError.SubmoduleRepositoryDoesNotExist:
      return i18n.t("gitErrors.aSubmodulePointsToALocationWhichDoesNotExist")
    case DugiteError.InvalidSubmoduleSHA:
      return i18n.t("gitErrors.aSubmodulePointsToACommitWhichDoesNotExist")
    case DugiteError.LocalPermissionDenied:
      return i18n.t("gitErrors.permissionDenied")
    case DugiteError.InvalidMerge:
      return i18n.t("gitErrors.thisIsNotSomethingWeCanMerge")
    case DugiteError.InvalidRebase:
      return i18n.t("gitErrors.thisIsNotSomethingWeCanRebase")
    case DugiteError.NonFastForwardMergeIntoEmptyHead:
      return i18n.t("gitErrors.theMergeYouAttemptedIsNotAFastForward")
    case DugiteError.PatchDoesNotApply:
      return i18n.t("gitErrors.theRequestedChangesConflictWithOneOrMoreFiles")
    case DugiteError.BranchAlreadyExists:
      return i18n.t("gitErrors.aBranchWithThatNameAlreadyExists")
    case DugiteError.BadRevision:
      return i18n.t("gitErrors.badRevision")
    case DugiteError.NotAGitRepository:
      return i18n.t("gitErrors.thisIsNotAGitRepository")
    case DugiteError.ProtectedBranchForcePush:
      return i18n.t("gitErrors.thisBranchIsProtectedFromForcePushOperations")
    case DugiteError.ProtectedBranchRequiresReview:
      return i18n.t("gitErrors.thisBranchIsProtectedAndAnyChangesRequiresAnApprovedReview")
    case DugiteError.PushWithFileSizeExceedingLimit:
      return i18n.t("gitErrors.thePushOperationIncludesAFileWhichExceedsGitHubsFileSizeRestriction")
    case DugiteError.HexBranchNameRejected:
      return i18n.t("gitErrors.theBranchNameCannotBeA40CharacterString")
    case DugiteError.ForcePushRejected:
      return i18n.t("gitErrors.theForcePushHasBeenRejected")
    case DugiteError.InvalidRefLength:
      return i18n.t("gitErrors.aRefCannotBeLongerThan255Characters")
    case DugiteError.CannotMergeUnrelatedHistories:
      return i18n.t("gitErrors.unableToMergeUnrelatedHistories")
    case DugiteError.PushWithPrivateEmail:
      return i18n.t("gitErrors.cannotPushTheseCommitsAsTheyContainAPrivateEmail")
    case DugiteError.LFSAttributeDoesNotMatch:
      return i18n.t("gitErrors.gitLfsAttributeFoundInGlobalGitConfigurationDoesNotMatch")
    case DugiteError.ProtectedBranchDeleteRejected:
      return i18n.t("gitErrors.thisBranchCannotBeDeletedFromTheRemoteRepository")
    case DugiteError.ProtectedBranchRequiredStatus:
      return i18n.t("gitErrors.thePushWasRejectedByTheRemoteServer")
    case DugiteError.BranchRenameFailed:
      return i18n.t("gitErrors.theBranchCouldNotBeRenamed")
    case DugiteError.PathDoesNotExist:
      return i18n.t("gitErrors.thePathDoesNotExistOnDisk")
    case DugiteError.InvalidObjectName:
      return i18n.t("gitErrors.theObjectWasNotFoundInTheGitRepository")
    case DugiteError.OutsideRepository:
      return i18n.t("gitErrors.thisPathIsNotAValidPathInsideTheRepository")
    case DugiteError.LockFileAlreadyExists:
      return i18n.t("gitErrors.aLockFileAlreadyExistsInTheRepository")
    case DugiteError.NoMergeToAbort:
      return i18n.t("gitErrors.thereIsNoMergeInProgress")
    case DugiteError.NoExistingRemoteBranch:
      return i18n.t("gitErrors.theRemoteBranchDoesNotExist")
    case DugiteError.LocalChangesOverwritten:
      return i18n.t("gitErrors.unableToSwitchBranchesAsThereAreWorkingDirectoryChanges")
    case DugiteError.UnresolvedConflicts:
      return i18n.t("gitErrors.thereAreUnresolvedConflictsInTheWorkingDirectory")
    case DugiteError.TagAlreadyExists:
      return i18n.t("gitErrors.aTagWithThatNameAlreadyExists")
    case DugiteError.ConfigLockFileAlreadyExists:
      // Added in dugite 1.88.0 (https://github.com/desktop/dugite/pull/386)
      // in support of https://github.com/desktop/desktop/issues/8675 but we're
      // not using it yet. Returning a null message here means the stderr will
      // be used as the error message (or stdout if stderr is empty), i.e. the
      // same behavior as before the ConfigLockFileAlreadyExists was added
      return null
    case DugiteError.RemoteAlreadyExists:
      return null
    case DugiteError.MergeWithLocalChanges:
    case DugiteError.RebaseWithLocalChanges:
    case DugiteError.GPGFailedToSignData:
    case DugiteError.ConflictModifyDeletedInBranch:
    case DugiteError.MergeCommitNoMainlineOption:
    case DugiteError.UnsafeDirectory:
    case DugiteError.PathExistsButNotInRef:
    case DugiteError.PushWithSecretDetected:
      return null
  }
}
