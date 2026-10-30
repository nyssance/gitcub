// Desktop MIT implementation extracted unchanged from lib/git/log.ts.

import { forceUnwrap } from "../../upstream/lib/fatal-error"
import {
  type AppFileStatus,
  AppFileStatusKind,
  CommittedFileChange,
  type CopiedOrRenamedFileStatus,
  type PlainFileStatus,
  type SubmoduleStatus,
  type UntrackedFileStatus
} from "../../upstream/models/status"

// File mode 160000 is used by git specifically for submodules:
// https://github.com/git/git/blob/v2.37.3/cache.h#L62-L69
const SubmoduleFileMode = "160000"

function mapSubmoduleStatusFileModes(status: string, srcMode: string, dstMode: string): SubmoduleStatus | undefined {
  return srcMode === SubmoduleFileMode && dstMode === SubmoduleFileMode && status === "M"
    ? {
        commitChanged: true,
        untrackedChanges: false,
        modifiedChanges: false
      }
    : (srcMode === SubmoduleFileMode && status === "D") || (dstMode === SubmoduleFileMode && status === "A")
      ? {
          commitChanged: false,
          untrackedChanges: false,
          modifiedChanges: false
        }
      : undefined
}

/**
 * Map the raw status text from Git to an app-friendly value
 * shamelessly borrowed from GitHub Desktop (Windows)
 */
function mapStatus(
  rawStatus: string,
  oldPath: string | undefined,
  srcMode: string,
  dstMode: string
): PlainFileStatus | CopiedOrRenamedFileStatus | UntrackedFileStatus {
  const status = rawStatus.trim()
  const submoduleStatus = mapSubmoduleStatusFileModes(status, srcMode, dstMode)

  if (status === "M") {
    return { kind: AppFileStatusKind.Modified, submoduleStatus }
  } // modified
  if (status === "A") {
    return { kind: AppFileStatusKind.New, submoduleStatus }
  } // added
  if (status === "?") {
    return { kind: AppFileStatusKind.Untracked, submoduleStatus }
  } // untracked
  if (status === "D") {
    return { kind: AppFileStatusKind.Deleted, submoduleStatus }
  } // deleted
  if (status === "R" && oldPath != null) {
    return {
      kind: AppFileStatusKind.Renamed,
      oldPath,
      submoduleStatus,
      renameIncludesModifications: false
    }
  } // renamed
  if (status === "C" && oldPath != null) {
    return {
      kind: AppFileStatusKind.Copied,
      oldPath,
      submoduleStatus,
      renameIncludesModifications: false
    }
  } // copied

  // git log -M --name-status will return a RXXX - where XXX is a percentage
  if (status.match(/R[0-9]+/) && oldPath != null) {
    return {
      kind: AppFileStatusKind.Renamed,
      oldPath,
      submoduleStatus,
      renameIncludesModifications: status !== "R100"
    }
  }

  // git log -C --name-status will return a CXXX - where XXX is a percentage
  if (status.match(/C[0-9]+/) && oldPath != null) {
    return {
      kind: AppFileStatusKind.Copied,
      oldPath,
      submoduleStatus,
      renameIncludesModifications: false
    }
  }

  return { kind: AppFileStatusKind.Modified, submoduleStatus }
}

const isCopyOrRename = (status: AppFileStatus): status is CopiedOrRenamedFileStatus =>
  status.kind === AppFileStatusKind.Copied || status.kind === AppFileStatusKind.Renamed

export function parseRawLogWithNumstat(stdout: string, sha: string, parentCommitish: string) {
  const files: CommittedFileChange[] = []
  let linesAdded = 0
  let linesDeleted = 0
  let numStatCount = 0
  const lines = stdout.split("\0")

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    if (line.startsWith(":")) {
      const lineComponents = line.split(" ")
      const srcMode = forceUnwrap("Invalid log output (srcMode)", lineComponents[0]?.replace(":", ""))
      const dstMode = forceUnwrap("Invalid log output (dstMode)", lineComponents[1])
      const status = forceUnwrap("Invalid log output (status)", lineComponents.at(-1))
      const oldPath = /^R|C/.test(status) ? forceUnwrap("Missing old path", lines.at(++i)) : undefined

      const path = forceUnwrap("Missing path", lines.at(++i))

      files.push(new CommittedFileChange(path, mapStatus(status, oldPath, srcMode, dstMode), sha, parentCommitish))
    } else {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(line)
      const [, added, deleted] = forceUnwrap("Invalid numstat line", match)
      linesAdded += added === "-" ? 0 : Number.parseInt(added, 10)
      linesDeleted += deleted === "-" ? 0 : Number.parseInt(deleted, 10)

      // If this entry denotes a rename or copy the old and new paths are on
      // two separate fields (separated by \0). Otherwise they're on the same
      // line as the added and deleted lines.
      if (isCopyOrRename(files[numStatCount].status)) {
        i += 2
      }
      numStatCount++
    }
  }

  return { files, linesAdded, linesDeleted }
}
