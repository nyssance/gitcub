// Desktop MIT port; platform imports adapted to Tauri.
import type * as React from "react"

import { assertNever } from "../../upstream/lib/fatal-error"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"

export const CommitWarningIcon = {
  Warning: 0,
  Information: 1,
  Error: 2
} as const
export type CommitWarningIcon = (typeof CommitWarningIcon)[keyof typeof CommitWarningIcon]

const renderIcon = (icon: CommitWarningIcon) => {
  let className = ""
  let symbol = octicons.alert

  switch (icon) {
    case CommitWarningIcon.Warning:
      className = "warning-icon"
      symbol = octicons.alert
      break
    case CommitWarningIcon.Information:
      className = "information-icon"
      symbol = octicons.info
      break
    case CommitWarningIcon.Error:
      className = "error-icon"
      symbol = octicons.stop
      break
    default:
      assertNever(icon, `Unexpected icon value ${icon}`)
  }

  return <Octicon className={className} symbol={symbol} />
}

/** A warning displayed above the commit button
 */
export const CommitWarning: React.FunctionComponent<
  React.PropsWithChildren<{
    readonly icon: CommitWarningIcon
  }>
> = props => {
  return (
    <div className="commit-warning-component" onContextMenu={ignoreContextMenu}>
      <div className="warning-icon-container">{renderIcon(props.icon)}</div>
      <div className="warning-message">{props.children}</div>
    </div>
  )
}

// Preserve the original Desktop component contract.
const ignoreContextMenu = (event: React.MouseEvent<HTMLElement>) => {
  // this prevents the context menu for the root element of CommitMessage from
  // firing - it shows 'Add Co-Authors' or 'Remove Co-Authors' based on the
  // form state, and for now I'm going to leave that behaviour as-is

  // feel free to remove this if that behaviour is revisited
  event.preventDefault()
}
