// Desktop MIT implementation extracted unchanged from lib/git/core.ts.
import { platform } from "@tauri-apps/plugin-os"

import { coerceToString } from "./coerce-to-string"
import { GitError } from "./git-error"
import * as Path from "./platform-path"

type IGitResult = GitError["result"] & { path: string }
export function isConfigFileLockError(error: unknown): error is GitError & { result: IGitResult } {
  return (
    error instanceof GitError &&
    error.result.gitError === "ConfigLockFileAlreadyExists" &&
    "path" in error.result &&
    typeof error.result.path === "string"
  )
}

const lockFilePathRe = /^error: could not lock config file (.+?): File exists$/m

/**
 * If the `result` is associated with an config lock file error (as determined
 * by `isConfigFileLockError`) this method will attempt to extract an absolute
 * path (i.e. rooted) to the configuration lock file in question from the Git
 * output.
 */
export function parseConfigLockFilePathFromError(result: IGitResult) {
  const match = lockFilePathRe.exec(coerceToString(result.stderr))

  if (match === null) {
    return null
  }

  // Git on Windows may print the config file path using forward slashes.
  // Luckily for us forward slashes are not allowed in Windows file or
  // directory names so we can simply replace any instance of forward
  // slashes with backslashes.
  const normalized = platform() === "windows" ? match[1].replace("/", "\\") : match[1]

  // https://github.com/git/git/blob/232378479/lockfile.h#L117-L119
  return Path.resolve(result.path, `${normalized}.lock`)
}
