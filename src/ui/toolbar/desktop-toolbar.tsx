// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

interface IToolbarProps {
  readonly id?: string
}

/** The main application toolbar component. */
// Preserve the original Desktop component contract.
export class Toolbar extends React.Component<React.PropsWithChildren<IToolbarProps>, Record<string, never>> {
  public render() {
    return (
      <div id={this.props.id} className="toolbar">
        {this.props.children}
      </div>
    )
  }
}
