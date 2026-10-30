import * as React from "react"

import { RadioGroup as StandardRadioGroup } from "../base/radio-group"
import { RadioButton } from "./radio-button"

interface IRadioGroupProps<T> {
  /** The id of the element that serves as the menu's accessibility label */
  readonly ariaLabelledBy?: string

  /**
   * The currently selected item, denoted by its key.
   */
  readonly selectedKey: T

  /**
   * The keys of the radio buttons to display, in order of the radio buttons.
   */
  readonly radioButtonKeys: ReadonlyArray<T>

  /** Optional class for radio group*/
  readonly className?: string

  /**
   * A function that's called whenever the selected item changes, either
   * as a result of a click using a pointer device or as a result of the user
   * hitting an up/down while the component has focus.
   *
   * The key argument corresponds to the key property of the selected item.
   */
  readonly onSelectionChanged: (key: T) => void

  /** Optional: The onDoubleClick event handler for radio button */
  readonly onRadioButtonDoubleClick?: (key: T, event: React.MouseEvent<HTMLLabelElement>) => void

  /** Render radio button label contents */
  readonly renderRadioButtonLabelContents: (key: T) => React.JSX.Element | string
}

export class RadioGroup<T extends string | number> extends React.Component<IRadioGroupProps<T>> {
  public render() {
    return (
      <StandardRadioGroup
        value={this.props.selectedKey}
        aria-labelledby={this.props.ariaLabelledBy}
        className={this.props.className}
        onValueChange={value => this.props.onSelectionChanged(value as T)}>
        {this.props.radioButtonKeys.map(key => (
          <RadioButton
            key={key}
            grouped
            value={key}
            checked={this.props.selectedKey === key}
            tabIndex={this.props.selectedKey === key ? 0 : -1}
            onSelected={() => {}}
            onDoubleClick={this.props.onRadioButtonDoubleClick}>
            {this.props.renderRadioButtonLabelContents(key)}
          </RadioButton>
        ))}
      </StandardRadioGroup>
    )
  }
}
