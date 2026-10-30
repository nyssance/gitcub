// Desktop MIT port; platform imports adapted to Tauri.

import classNames from "classnames"
import * as React from "react"

import { Button } from "./button"
import { Row } from "./row"

interface ICallToActionProps {
  /** The action title. */
  readonly actionTitle: string

  readonly buttonClassName?: string

  /** The function to call when the user clicks the action button. */
  readonly onAction: () => void
}

/**
 * A call-to-action component which displays its children as the message
 * followed by an action button.
 */
// Preserve the original Desktop component contract.
export class CallToAction extends React.Component<React.PropsWithChildren<ICallToActionProps>, Record<string, never>> {
  public render() {
    const className = classNames("action-button", "button-component-primary", this.props.buttonClassName)
    return (
      <Row className="call-to-action">
        {this.props.children}
        <Button className={className} onClick={this.onClick}>
          {this.props.actionTitle}
        </Button>
      </Row>
    )
  }

  private onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()

    this.props.onAction()
  }
}
