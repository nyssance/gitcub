// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { enableFormattingPreferences } from "../../lib/desktop-features"
import { formatCompactNumber } from "../../lib/format-number"

interface IFilesChangedBadgeProps {
  readonly filesChangedCount: number
}

/** The number that can be displayed as a specific value */
const MaximumChangesCount = 300

/** Displays number of files that have changed */
// Preserve the original Desktop component contract.
export class FilesChangedBadge extends React.Component<IFilesChangedBadgeProps, Record<string, never>> {
  public render() {
    if (enableFormattingPreferences()) {
      return <span className="counter">{formatCompactNumber(this.props.filesChangedCount)}</span>
    }

    const filesChangedCount = this.props.filesChangedCount
    const badgeCount = filesChangedCount > MaximumChangesCount ? `${MaximumChangesCount}+` : filesChangedCount

    return <span className="counter">{badgeCount}</span>
  }
}
