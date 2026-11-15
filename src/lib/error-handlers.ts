// Desktop MIT port of ui/dispatcher/error-handlers.ts localChangesOverwrittenHandler. Desktop 的处理器弹
// PopupType.LocalChangesOverwritten 后返回 null；这里返回要弹的内容，交给 dialogs store 显示。
import { Repository } from "../models/repository"
import type { RetryAction } from "../models/retry-actions"
import { coerceToString } from "./coerce-to-string"
import { DugiteError } from "./dugite-errors"
import { ErrorWithMetadata } from "./error-with-metadata"
import { GitError } from "./git-error"
import { parseFilesToBeOverwritten } from "./parse-files-to-be-overwritten"

export interface LocalChangesOverwrittenPopup {
  readonly retryAction: RetryAction
  readonly files: ReadonlyArray<string>
}

/**
 * Handler for when an action the user attempts cannot be done because there are local
 * changes that would get overwritten.
 */
export function localChangesOverwrittenHandler(error: Error): LocalChangesOverwrittenPopup | null {
  if (!(error instanceof ErrorWithMetadata)) {
    return null
  }

  const gitError = error.underlyingError instanceof GitError ? error.underlyingError : null
  if (gitError === null) {
    return null
  }

  const dugiteError = gitError.result.gitError

  if (
    dugiteError !== DugiteError.LocalChangesOverwritten &&
    dugiteError !== DugiteError.MergeWithLocalChanges &&
    dugiteError !== DugiteError.RebaseWithLocalChanges
  ) {
    return null
  }

  const { repository, retryAction } = error.metadata

  if (!(repository instanceof Repository)) {
    return null
  }

  if (retryAction === undefined) {
    return null
  }

  const files = parseFilesToBeOverwritten(coerceToString(gitError.result.stderr))

  return { retryAction, files }
}
