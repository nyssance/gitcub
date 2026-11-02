// Desktop MIT implementation extracted unchanged from lib/git/core.ts.

import { coerceToString } from "./coerce-to-string"
import type { GitCommandResult } from "./git-result"

type IGitResult = GitCommandResult & { gitErrorDescription?: string | null; gitError?: string | null }
type DugiteError = string
export class GitError extends Error {
  /** The result from the failed command. */
  public readonly result: IGitResult

  /** The args for the failed command. */
  public readonly args: ReadonlyArray<string>

  /**
   * Whether or not the error message is just the raw output of the git command.
   */
  public readonly isRawMessage: boolean

  public constructor(result: IGitResult, args: ReadonlyArray<string> = [], terminalOutput: string = "") {
    let rawMessage = true
    // Preserve the original Desktop implementation and contract.
    let message

    if (result.gitErrorDescription) {
      message = result.gitErrorDescription
      rawMessage = false
    } else if (terminalOutput.length > 0) {
      message = terminalOutput
    } else if (result.stderr.length) {
      message = coerceToString(result.stderr)
    } else if (result.stdout.length) {
      message = coerceToString(result.stdout)
    } else {
      message = `Unknown error (exit code ${result.exitCode})`
      rawMessage = false
    }

    super(message)

    this.name = "GitError"
    this.result = result
    this.args = args
    this.isRawMessage = rawMessage
  }
}

export const isGitError = (e: unknown, parsedError?: DugiteError): e is GitError => {
  return e instanceof GitError && (parsedError === undefined || e.result.gitError === parsedError)
}
