import classNames from "classnames"
// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { FieldGroup } from "../base/field"

interface IFormProps {
  /** The class name for the form. */
  readonly className?: string

  /** Called when the form is submitted. */
  readonly onSubmit?: () => void
}

/** A form element with app-standard styles. */
// Preserve the original Desktop component contract.
export class Form extends React.Component<React.PropsWithChildren<IFormProps>, Record<string, never>> {
  public render() {
    const className = classNames("form-component", this.props.className)
    return (
      <form className={className} onSubmit={this.onSubmit}>
        <FieldGroup>{this.props.children}</FieldGroup>
      </form>
    )
  }

  private onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (this.props.onSubmit) {
      this.props.onSubmit()
    }
  }
}
