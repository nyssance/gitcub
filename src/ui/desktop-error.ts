// Desktop MIT implementation extracted unchanged from ui/app-error.tsx.
import { ErrorWithMetadata } from "../lib/error-with-metadata"
import { GitError } from "../lib/git-error"
export function getUnderlyingError(error: Error): Error {
  return isErrorWithMetaData(error) ? error.underlyingError : error
}

export function isErrorWithMetaData(error: Error): error is ErrorWithMetadata {
  return error instanceof ErrorWithMetadata
}

export function isGitError(error: Error): error is GitError {
  return error instanceof GitError
}

export function isRawGitError(error: Error | null) {
  if (!error) {
    return false
  }
  const e = getUnderlyingError(error)
  return e instanceof GitError && e.isRawMessage
}
