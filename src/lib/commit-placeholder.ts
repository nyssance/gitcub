// Desktop MIT implementation extracted unchanged from filter-changes-list.tsx.

import { AppFileStatusKind, type WorkingDirectoryFileChange } from "../upstream/models/status"
import { basename } from "./platform-path"
export function getPlaceholderMessage(
  files: ReadonlyArray<WorkingDirectoryFileChange>,
  prepopulateCommitSummary: boolean
) {
  if (!prepopulateCommitSummary) {
    return "Summary (required)"
  }

  const firstFile = files[0]
  const fileName = basename(firstFile.path)

  switch (firstFile.status.kind) {
    case AppFileStatusKind.New:
    case AppFileStatusKind.Untracked:
      return `Create ${fileName}`
    case AppFileStatusKind.Deleted:
      return `Delete ${fileName}`
    default:
      // TODO:
      // this doesn't feel like a great message for AppFileStatus.Copied or
      // AppFileStatus.Renamed but without more insight (and whether this
      // affects other parts of the flow) we can just default to this for now
      return `Update ${fileName}`
  }
}
