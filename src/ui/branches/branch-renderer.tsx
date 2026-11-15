// Desktop MIT port: app/src/ui/branches/branch-renderer.tsx.

import type * as React from "react"

import type { IBranchListItem } from "../../lib/group-branches"
import type { Branch } from "../../models/branch"
import { getPreferAbsoluteDates } from "../../models/formatting-preferences"
import type { IMatches } from "../../upstream/lib/fuzzy-find"
import { getRelativeTimeInfoFromDate } from "../relative-time"
import { BranchListItem } from "./branch-list-item"

export function renderDefaultBranch(
  item: IBranchListItem,
  matches: IMatches,
  currentBranch: Branch | null,
  authorDate: Date | undefined,
  onDropOntoBranch?: (branchName: string) => void,
  onDropOntoCurrentBranch?: () => void
): React.JSX.Element {
  const branch = item.branch
  const currentBranchName = currentBranch ? currentBranch.name : null
  return (
    <BranchListItem
      name={branch.name}
      isCurrentBranch={branch.name === currentBranchName}
      authorDate={authorDate}
      matches={matches}
      onDropOntoBranch={onDropOntoBranch}
      onDropOntoCurrentBranch={onDropOntoCurrentBranch}
    />
  )
}

export function getDefaultAriaLabelForBranch(item: IBranchListItem, authorDate: Date | undefined): string {
  const branch = item.branch

  if (!authorDate) {
    return branch.name
  }

  const { relativeText, absoluteText } = getRelativeTimeInfoFromDate(authorDate, true)

  return `${item.branch.name} ${getPreferAbsoluteDates() ? absoluteText : relativeText}`
}
