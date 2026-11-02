// Desktop value contract, rendered by standard shadcn Checkbox.
import * as React from "react"

import { cn } from "../../lib/utils"
import { Checkbox as StandardCheckbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
export enum CheckboxValue {
  On,
  Off,
  Mixed
}

interface ICheckboxProps {
  /** Is the component disabled. */
  readonly disabled?: boolean

  /** The current value of the component. */
  readonly value: CheckboxValue

  /** The function to call on value change. */
  readonly onChange?: (checked: boolean) => void

  /** The tab index of the input element. */
  readonly tabIndex?: number

  /** The label for the checkbox. */
  readonly label?: string | React.JSX.Element

  /** An id of label of a checkbox (when built in label won't work) */
  readonly ariaLabelledBy?: string

  /** An aria description of a checkbox - intended to provide more verbose
   * information than a label that a the user might need */
  readonly ariaDescribedBy?: string

  readonly className?: string
}

export class Checkbox extends React.Component<ICheckboxProps> {
  private readonly id = crypto.randomUUID()
  private element: HTMLElement | null = null
  public focus() {
    this.element?.focus()
  }
  public render() {
    return (
      <Field
        orientation="horizontal"
        className={cn("checkbox-component", this.props.className)}
        onDoubleClick={event => {
          event.preventDefault()
          event.stopPropagation()
        }}>
        <StandardCheckbox
          ref={element => {
            this.element = element
          }}
          id={this.id}
          checked={this.props.value !== CheckboxValue.Off}
          indeterminate={this.props.value === CheckboxValue.Mixed}
          onCheckedChange={this.props.onChange}
          disabled={this.props.disabled}
          tabIndex={this.props.tabIndex}
          aria-labelledby={this.props.ariaLabelledBy}
          aria-describedby={this.props.ariaDescribedBy}
        />
        {this.props.label && <FieldLabel htmlFor={this.id}>{this.props.label}</FieldLabel>}
      </Field>
    )
  }
}
