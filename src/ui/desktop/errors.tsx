// Desktop MIT port; platform imports adapted to Tauri.

import classNames from "classnames"
import * as React from "react"

interface IErrorsProps {
  /** The class name for the internal element. */
  readonly className?: string
}

/**
 * An Errors element with app-standard styles.
 *
 * Provide `children` elements to render as the content for the error element.
 */
// Preserve the original Desktop component contract.
export class Errors extends React.Component<React.PropsWithChildren<IErrorsProps>, Record<string, never>> {
  public render() {
    const className = classNames("errors-component", this.props.className)
    return (
      <div className={className} role="alert">
        {this.props.children}
      </div>
    )
  }
}
