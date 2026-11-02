// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import type { IMatches } from "../../upstream/lib/fuzzy-find"
import { type AppFileStatus, AppFileStatusKind } from "../../upstream/models/status"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"
import { PathText } from "./path-text"

interface IPathLabelProps {
  /** the current path of the file */
  readonly path: string
  /** the type of change applied to the file */
  readonly status: AppFileStatus

  readonly availableWidth?: number

  /** aria hidden value */
  readonly ariaHidden?: boolean

  /** The characters in the file path to highlight */
  readonly matches?: IMatches
}

/** The pixel width reserved to give the resize arrow padding on either side. */
const ResizeArrowPadding = 10

/**
 * Render the path details for a given file.
 *
 * For renames, this will render the old path as well as the current path.
 * For other scenarios, only the current path is rendered.
 *
 */
// Preserve the original Desktop implementation and contract.
export class PathLabel extends React.Component<IPathLabelProps, Record<string, never>> {
  public render() {
    const props: React.HTMLProps<HTMLLabelElement> = {
      className: "path-label-component inline-flex min-w-0 items-center gap-2"
    }

    const { status, matches } = this.props

    const availableWidth = this.props.availableWidth
    if (status.kind === AppFileStatusKind.Renamed || status.kind === AppFileStatusKind.Copied) {
      const segmentWidth = availableWidth ? availableWidth / 2 - ResizeArrowPadding : undefined
      return (
        <span {...props} aria-hidden={this.props.ariaHidden}>
          <PathText path={status.oldPath} availableWidth={segmentWidth} />
          <Octicon className="rename-arrow shrink-0" symbol={octicons.arrowRight} />
          <PathText path={this.props.path} availableWidth={segmentWidth} matches={matches} />
        </span>
      )
    } else {
      return (
        <span {...props} aria-hidden={this.props.ariaHidden}>
          <PathText path={this.props.path} matches={matches} availableWidth={availableWidth} />
        </span>
      )
    }
  }
}
