// Desktop MIT implementation extracted unchanged from lib/git/log.ts.
import type { CommittedFileChange } from "../upstream/models/status"
export interface IChangesetData {
  /** Files changed in the changeset. */
  readonly files: ReadonlyArray<CommittedFileChange>

  /** Number of lines added in the changeset. */
  readonly linesAdded: number

  /** Number of lines deleted in the changeset. */
  readonly linesDeleted: number
}
