// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

const BlankSlateImage = "/static/multiple-files-selected.svg"

interface IMultipleSelectionProps {
  /** Called when the user chooses to open the repository. */
  readonly count: number
}
/** The component to display when there are no local changes. */
export class MultipleSelection extends React.Component<
  IMultipleSelectionProps,
  // Preserve the original Desktop implementation and contract.
  Record<string, never>
> {
  public render() {
    return (
      <div className="panel blankslate" id="no-changes">
        <img src={BlankSlateImage} className="blankslate-image" alt="" />
        <div>{this.props.count} files selected</div>
      </div>
    )
  }
}
