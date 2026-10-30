import classNames from "classnames"
// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { Toggle } from "../base/toggle"

interface IToggleButtonProps {
  /**
   * Indicate whether the toggle button should be rendered in a defined state.
   *
   * If not specified, button state defaults to false (unchecked).
   */
  readonly checked?: boolean

  /** A function to call when the checked state of the component changes */
  readonly onClick?: (checked: boolean) => void

  /** The title of the button. */
  readonly children?: string

  /** Is the button disabled? */
  readonly disabled?: boolean

  /** CSS class names */
  readonly className?: string

  /**
   * The `ref` for the underlying <button> element.
   *
   * Ideally this would be named `ref`, but TypeScript seems to special-case its
   * handling of the `ref` type into some ungodly monstrosity. Hopefully someday
   * this will be unnecessary.
   */
  readonly onButtonRef?: (instance: HTMLButtonElement | null) => void
}

interface IToggleButtonState {
  /** track the internal state of the toggle button */
  readonly isChecked: boolean
}

/** A button component that can be unchecked or checked by the user. */
export class ToggleButton extends React.Component<React.PropsWithChildren<IToggleButtonProps>, IToggleButtonState> {
  public constructor(props: IToggleButtonProps) {
    super(props)

    this.state = { isChecked: props.checked || false }
  }

  /** check the current state of the toggle button */
  private isChecked(): boolean {
    return this.props.checked ?? this.state.isChecked
  }

  public render() {
    const classNameState = this.isChecked() ? "checked" : "unchecked"
    const className = classNames("button-component", this.props.className, classNameState)

    return (
      <Toggle
        pressed={this.isChecked()}
        className={className}
        disabled={this.props.disabled}
        onPressedChange={this.onPressedChange}
        type="button"
        ref={this.props.onButtonRef}>
        {this.props.children}
      </Toggle>
    )
  }

  private onPressedChange = (isChecked: boolean) => {
    this.setState({ isChecked })
    this.props.onClick?.(isChecked)
  }
}
