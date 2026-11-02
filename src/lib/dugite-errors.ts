// dugite 3.3.2 MIT port of lib/errors.ts（GitError、GitErrorRegexes）、lib/parse-error.ts 与
// lib/parse-bad-config-value-error-info.ts，Desktop 用它识别 git 输出里的错误种类（lib/git/core.ts git()）。
// 包里只发布编译后的 JS，这里按 build/lib/errors.js 逐条还原；枚举值用名字而不是数字，与后端 classify_error 的名字一致。

/** The git errors which can be parsed from failed git commands. */
export enum DugiteError {
  BadConfigValue = "BadConfigValue",
  SSHKeyAuditUnverified = "SSHKeyAuditUnverified",
  SSHAuthenticationFailed = "SSHAuthenticationFailed",
  SSHPermissionDenied = "SSHPermissionDenied",
  HTTPSAuthenticationFailed = "HTTPSAuthenticationFailed",
  RemoteDisconnection = "RemoteDisconnection",
  HostDown = "HostDown",
  RebaseConflicts = "RebaseConflicts",
  MergeConflicts = "MergeConflicts",
  HTTPSRepositoryNotFound = "HTTPSRepositoryNotFound",
  SSHRepositoryNotFound = "SSHRepositoryNotFound",
  PushNotFastForward = "PushNotFastForward",
  BranchDeletionFailed = "BranchDeletionFailed",
  DefaultBranchDeletionFailed = "DefaultBranchDeletionFailed",
  RevertConflicts = "RevertConflicts",
  EmptyRebasePatch = "EmptyRebasePatch",
  NoMatchingRemoteBranch = "NoMatchingRemoteBranch",
  NoExistingRemoteBranch = "NoExistingRemoteBranch",
  NothingToCommit = "NothingToCommit",
  NoSubmoduleMapping = "NoSubmoduleMapping",
  SubmoduleRepositoryDoesNotExist = "SubmoduleRepositoryDoesNotExist",
  InvalidSubmoduleSHA = "InvalidSubmoduleSHA",
  LocalPermissionDenied = "LocalPermissionDenied",
  InvalidMerge = "InvalidMerge",
  InvalidRebase = "InvalidRebase",
  NonFastForwardMergeIntoEmptyHead = "NonFastForwardMergeIntoEmptyHead",
  PatchDoesNotApply = "PatchDoesNotApply",
  BranchAlreadyExists = "BranchAlreadyExists",
  BadRevision = "BadRevision",
  NotAGitRepository = "NotAGitRepository",
  CannotMergeUnrelatedHistories = "CannotMergeUnrelatedHistories",
  LFSAttributeDoesNotMatch = "LFSAttributeDoesNotMatch",
  BranchRenameFailed = "BranchRenameFailed",
  PathDoesNotExist = "PathDoesNotExist",
  InvalidObjectName = "InvalidObjectName",
  OutsideRepository = "OutsideRepository",
  LockFileAlreadyExists = "LockFileAlreadyExists",
  NoMergeToAbort = "NoMergeToAbort",
  LocalChangesOverwritten = "LocalChangesOverwritten",
  UnresolvedConflicts = "UnresolvedConflicts",
  GPGFailedToSignData = "GPGFailedToSignData",
  ConflictModifyDeletedInBranch = "ConflictModifyDeletedInBranch",
  // Start of GitHub-specific error codes
  PushWithFileSizeExceedingLimit = "PushWithFileSizeExceedingLimit",
  HexBranchNameRejected = "HexBranchNameRejected",
  ForcePushRejected = "ForcePushRejected",
  InvalidRefLength = "InvalidRefLength",
  ProtectedBranchRequiresReview = "ProtectedBranchRequiresReview",
  ProtectedBranchForcePush = "ProtectedBranchForcePush",
  ProtectedBranchDeleteRejected = "ProtectedBranchDeleteRejected",
  ProtectedBranchRequiredStatus = "ProtectedBranchRequiredStatus",
  PushWithPrivateEmail = "PushWithPrivateEmail",
  // End of GitHub-specific error codes
  ConfigLockFileAlreadyExists = "ConfigLockFileAlreadyExists",
  RemoteAlreadyExists = "RemoteAlreadyExists",
  TagAlreadyExists = "TagAlreadyExists",
  MergeWithLocalChanges = "MergeWithLocalChanges",
  RebaseWithLocalChanges = "RebaseWithLocalChanges",
  MergeCommitNoMainlineOption = "MergeCommitNoMainlineOption",
  UnsafeDirectory = "UnsafeDirectory",
  PathExistsButNotInRef = "PathExistsButNotInRef",
  PushWithSecretDetected = "PushWithSecretDetected"
}

/** A mapping from regexes to the git error they identify. */
export const GitErrorRegexes: { [regexp: string]: DugiteError } = {
  "fatal: bad (?:numeric|boolean) config value '(.+)' for '(.+)'": DugiteError.BadConfigValue,
  "ERROR: ([\\s\\S]+?)\\n+\\[EPOLICYKEYAGE\\]\\n+fatal: Could not read from remote repository.":
    DugiteError.SSHKeyAuditUnverified,
  "fatal: Authentication failed for 'https?://": DugiteError.HTTPSAuthenticationFailed,
  "fatal: Authentication failed": DugiteError.SSHAuthenticationFailed,
  "fatal: Could not read from remote repository.": DugiteError.SSHPermissionDenied,
  "The requested URL returned error: 403": DugiteError.HTTPSAuthenticationFailed,
  "fatal: [Tt]he remote end hung up unexpectedly": DugiteError.RemoteDisconnection,
  "fatal: unable to access '(.+)': Failed to connect to (.+): Host is down": DugiteError.HostDown,
  "Cloning into '(.+)'...\nfatal: unable to access '(.+)': Could not resolve host: (.+)": DugiteError.HostDown,
  "Resolve all conflicts manually, mark them as resolved with": DugiteError.RebaseConflicts,
  "(Merge conflict|Automatic merge failed; fix conflicts and then commit the result)": DugiteError.MergeConflicts,
  "fatal: repository '(.+)' not found": DugiteError.HTTPSRepositoryNotFound,
  "ERROR: Repository not found": DugiteError.SSHRepositoryNotFound,
  "\\((non-fast-forward|fetch first)\\)\nerror: failed to push some refs to '.*'": DugiteError.PushNotFastForward,
  "error: unable to delete '(.+)': remote ref does not exist": DugiteError.BranchDeletionFailed,
  "\\[remote rejected\\] (.+) \\(deletion of the current branch prohibited\\)": DugiteError.DefaultBranchDeletionFailed,
  "error: could not revert .*\nhint: after resolving the conflicts, mark the corrected paths\nhint: with 'git add <paths>' or 'git rm <paths>'\nhint: and commit the result with 'git commit'":
    DugiteError.RevertConflicts,
  "Applying: .*\nNo changes - did you forget to use 'git add'\\?\nIf there is nothing left to stage, chances are that something else\n.*":
    DugiteError.EmptyRebasePatch,
  "There are no candidates for (rebasing|merging) among the refs that you just fetched.\nGenerally this means that you provided a wildcard refspec which had no\nmatches on the remote end.":
    DugiteError.NoMatchingRemoteBranch,
  "Your configuration specifies to merge with the ref '(.+)'\nfrom the remote, but no such ref was fetched.":
    DugiteError.NoExistingRemoteBranch,
  "nothing to commit": DugiteError.NothingToCommit,
  "[Nn]o submodule mapping found in .gitmodules for path '(.+)'": DugiteError.NoSubmoduleMapping,
  "fatal: repository '(.+)' does not exist\nfatal: clone of '.+' into submodule path '(.+)' failed":
    DugiteError.SubmoduleRepositoryDoesNotExist,
  "Fetched in submodule path '(.+)', but it did not contain (.+). Direct fetching of that commit failed.":
    DugiteError.InvalidSubmoduleSHA,
  "fatal: could not create work tree dir '(.+)'.*: Permission denied": DugiteError.LocalPermissionDenied,
  "merge: (.+) - not something we can merge": DugiteError.InvalidMerge,
  "invalid upstream (.+)": DugiteError.InvalidRebase,
  "fatal: Non-fast-forward commit does not make sense into an empty head": DugiteError.NonFastForwardMergeIntoEmptyHead,
  "error: (.+): (patch does not apply|already exists in working directory)": DugiteError.PatchDoesNotApply,
  "fatal: [Aa] branch named '(.+)' already exists.?": DugiteError.BranchAlreadyExists,
  "fatal: bad revision '(.*)'": DugiteError.BadRevision,
  "fatal: [Nn]ot a git repository \\(or any of the parent directories\\): (.*)": DugiteError.NotAGitRepository,
  "fatal: refusing to merge unrelated histories": DugiteError.CannotMergeUnrelatedHistories,
  "[Tt]he .+ attribute should be .+ but is .+": DugiteError.LFSAttributeDoesNotMatch,
  "fatal: Branch rename failed": DugiteError.BranchRenameFailed,
  "fatal: path '(.+)' does not exist .+": DugiteError.PathDoesNotExist,
  "fatal: invalid object name '(.+)'.": DugiteError.InvalidObjectName,
  "fatal: .+: '(.+)' is outside repository": DugiteError.OutsideRepository,
  "Another git process seems to be running in this repository, e.g.": DugiteError.LockFileAlreadyExists,
  "fatal: There is no merge to abort": DugiteError.NoMergeToAbort,
  "error: (?:Your local changes to the following|The following untracked working tree) files would be overwritten by checkout:":
    DugiteError.LocalChangesOverwritten,
  "You must edit all merge conflicts and then\nmark them as resolved using git add|fatal: Exiting because of an unresolved conflict":
    DugiteError.UnresolvedConflicts,
  "error: gpg failed to sign the data": DugiteError.GPGFailedToSignData,
  "CONFLICT \\(modify/delete\\): (.+) deleted in (.+) and modified in (.+)": DugiteError.ConflictModifyDeletedInBranch,
  // GitHub-specific errors
  "error: GH001: ": DugiteError.PushWithFileSizeExceedingLimit,
  "error: GH002: ": DugiteError.HexBranchNameRejected,
  "error: GH003: Sorry, force-pushing to (.+) is not allowed.": DugiteError.ForcePushRejected,
  "error: GH005: Sorry, refs longer than (.+) bytes are not allowed": DugiteError.InvalidRefLength,
  "error: GH006: Protected branch update failed for (.+)\nremote: error: At least one approved review is required":
    DugiteError.ProtectedBranchRequiresReview,
  "error: GH006: Protected branch update failed for (.+)\nremote: error: Cannot force-push to a protected branch":
    DugiteError.ProtectedBranchForcePush,
  "error: GH006: Protected branch update failed for (.+)\nremote: error: Cannot delete a protected branch":
    DugiteError.ProtectedBranchDeleteRejected,
  'error: GH006: Protected branch update failed for (.+).\nremote: error: Required status check "(.+)" is expected':
    DugiteError.ProtectedBranchRequiredStatus,
  "error: GH007: Your push would publish a private email address.": DugiteError.PushWithPrivateEmail,
  "error: could not lock config file (.+): File exists": DugiteError.ConfigLockFileAlreadyExists,
  "error: remote (.+) already exists.": DugiteError.RemoteAlreadyExists,
  "fatal: tag '(.+)' already exists": DugiteError.TagAlreadyExists,
  "error: Your local changes to the following files would be overwritten by merge:\n":
    DugiteError.MergeWithLocalChanges,
  "error: cannot (pull with rebase|rebase): You have unstaged changes\\.\n\\s*error: [Pp]lease commit or stash them\\.":
    DugiteError.RebaseWithLocalChanges,
  "error: commit (.+) is a merge but no -m option was given": DugiteError.MergeCommitNoMainlineOption,
  "fatal: detected dubious ownership in repository at (.+)": DugiteError.UnsafeDirectory,
  "fatal: path '(.+)' exists on disk, but not in '(.+)'": DugiteError.PathExistsButNotInRef,
  "GITHUB PUSH PROTECTION[.\\s\\S]+Push cannot contain secrets": DugiteError.PushWithSecretDetected
}

/** dugite parseError：按表的顺序找第一条能匹配的正则 */
export const parseError = (stderr: string): DugiteError | null =>
  Object.entries(GitErrorRegexes).find(([re]) => stderr.match(re))?.[1] ?? null

export function parseBadConfigValueErrorInfo(stderr: string): { key: string; value: string } | null {
  const errorEntry = Object.entries(GitErrorRegexes).find(([_, v]) => v === DugiteError.BadConfigValue)

  if (errorEntry === undefined) {
    return null
  }

  const m = stderr.match(errorEntry[0])

  if (m === null) {
    return null
  }

  if (!m[1] || !m[2]) {
    return null
  }

  return { key: m[2], value: m[1] }
}
