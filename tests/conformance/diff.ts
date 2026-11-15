import { toTextDiff } from "../../src/lib/diff"
import type { IRawDiff } from "../../src/upstream/models/diff"
import type { FileChange } from "../../src/upstream/models/status"

export async function getWorkingDirectoryDiff(repo: { path: string }, file: FileChange, hideWhitespace = false) {
  const { getWorkingDirectoryDiff } = await import("../../src/lib/diff")
  return getWorkingDirectoryDiff(repo.path, file, hideWhitespace)
}
export async function convertDiff(_repo: unknown, _file: unknown, raw: IRawDiff, ..._refs: unknown[]) {
  return toTextDiff(raw)
}
