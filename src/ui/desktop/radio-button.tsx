import * as React from "react"

import { FieldLabel } from "../base/field"
import { RadioGroup, RadioGroupItem } from "../base/radio-group"

interface IRadioButtonProps<T> {
  /**
   * Called when the user selects this radio button.
   *
   * The function will be called with the value of the RadioButton
   * and the original event that triggered the change.
   */
  readonly onSelected: (value: T) => void

  /**
   * Whether the radio button is selected.
   */
  readonly checked: boolean
  readonly grouped?: boolean

  /**
   * The label of the radio button. If not provided, the children are used
   */
  readonly label?: string | React.JSX.Element

  /**
   * The value of the radio button.
   */
  readonly value: T

  /** Optional: The tab index of the radio button */
  readonly tabIndex?: number

  /** Whether the textarea field should auto focus when mounted. */
  readonly autoFocus?: boolean

  /** Optional: The onDoubleClick event handler for radio button */
  readonly onDoubleClick?: (key: T, event: React.MouseEvent<HTMLLabelElement>) => void
}

export class RadioButton<T extends string | number> extends React.Component<
  React.PropsWithChildren<IRadioButtonProps<T>>
> {
  private readonly id = crypto.randomUUID()
  public render() {
    const content = (
      <FieldLabel
        className="radio-button-component flex items-center gap-2"
        htmlFor={this.id}
        onDoubleClick={event => this.props.onDoubleClick?.(this.props.value, event)}>
        <RadioGroupItem
          id={this.id}
          value={this.props.value}
          tabIndex={this.props.tabIndex}
          autoFocus={this.props.autoFocus}
        />
        <span>{this.props.label ?? this.props.children}</span>
      </FieldLabel>
    )
    return this.props.grouped ? (
      content
    ) : (
      <RadioGroup
        value={this.props.checked ? this.props.value : null}
        onValueChange={() => this.props.onSelected(this.props.value)}>
        {content}
      </RadioGroup>
    )
  }
}
