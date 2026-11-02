// Desktop MIT port; platform imports adapted to Tauri.

import classNames from "classnames"
import * as React from "react"

interface IRowProps {
  /** The id of the internal element */
  readonly id?: string

  /** The class name for the internal element. */
  readonly className?: string
}

/**
 * A horizontal row element with app-standard styles.
 *
 * Provide `children` elements for the contents of this row.
 */
// Preserve the original Desktop component contract.
export class Row extends React.Component<React.PropsWithChildren<IRowProps>, Record<string, never>> {
  public render() {
    const className = classNames("row-component flex items-center gap-3", this.props.className)
    return (
      <div id={this.props.id} className={className}>
        {this.props.children}
      </div>
    )
  }
}
