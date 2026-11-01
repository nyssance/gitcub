// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { DialogFooter as StandardFooter } from "@/components/ui/dialog"

/**
 * A container component for footer content in a Dialog.
 * This component should only be used at most once in any given dialog and it
 * should be rendered as the last child of that dialog.
 *
 * Provide `children` to display content inside the dialog footer.
 */
// Preserve the original Desktop component contract.
export class DialogFooter extends React.Component<React.PropsWithChildren, Record<string, never>> {
  public render() {
    return <StandardFooter className="dialog-footer">{this.props.children}</StandardFooter>
  }
}
