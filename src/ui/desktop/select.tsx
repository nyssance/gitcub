import classNames from "classnames"
import * as React from "react"
// Desktop MIT port; platform imports adapted to Tauri.

import { createUniqueId, releaseUniqueId } from "../../lib/ui/id-pool"
import { Field, FieldLabel } from "@/components/ui/field"
import { NativeSelect } from "@/components/ui/native-select"

interface ISelectProps {
  /** The label for the select control. */
  readonly label?: string

  /** Accessible name when the visible label is provided by a settings row. */
  readonly ariaLabel?: string

  /** The className for the select component. */
  readonly className?: string

  /** The value of the select control. */
  readonly value?: string

  /** The default value of the select control. */
  readonly defaultValue?: string

  /** Whether or not the select control is disabled. False by default. */
  readonly disabled?: boolean

  /** Called when the user changes the selected valued. */
  readonly onChange?: (event: React.FormEvent<HTMLSelectElement>) => void
}

interface ISelectState {
  /**
   * An automatically generated id for the input element used to reference
   * it from the label element. This is generated once via the id pool when the
   * component is mounted and then released once the component unmounts.
   */
  readonly inputId?: string
}

/**
 * A select element with app-standard styles.
 *
 * Provide `children` elements for the contents of the `select` element.
 */
export class Select extends React.Component<React.PropsWithChildren<ISelectProps>, ISelectState> {
  public componentWillMount() {
    const friendlyName = this.props.label || "unknown"
    const inputId = createUniqueId(`Select_${friendlyName}`)

    this.setState({ inputId })
  }

  public componentWillUnmount() {
    if (this.state.inputId) {
      releaseUniqueId(this.state.inputId)
    }
  }

  private renderLabel() {
    const label = this.props.label
    const inputId = this.state.inputId

    return label ? <FieldLabel htmlFor={inputId}>{label}</FieldLabel> : null
  }

  public render() {
    return (
      <Field className={classNames("select-component", this.props.className)}>
        {this.renderLabel()}
        <NativeSelect
          id={this.state.inputId}
          aria-label={this.props.ariaLabel}
          onChange={this.props.onChange}
          value={this.props.value}
          defaultValue={this.props.defaultValue}
          disabled={this.props.disabled}>
          {this.props.children}
        </NativeSelect>
      </Field>
    )
  }
}
