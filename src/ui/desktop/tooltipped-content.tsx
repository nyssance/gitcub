/* eslint-disable react/no-children-prop -- Preserve original behavior; array copies retain mutation-safe iteration and effects own their lifecycle. */

// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { createObservableRef } from "../../lib/ui/observable-ref"
import { type ITooltipProps, Tooltip } from "./tooltip"

/**
 * ITooltippedContentProps is a superset of ITooltipProps but does not
 * define the `target` prop as that's set programatically in render
 */
interface ITooltippedContentProps extends Omit<ITooltipProps<HTMLElement>, "target"> {
  /** The tooltip contents */
  readonly tooltip: React.JSX.Element | string | undefined

  /** The wrapper element tag name, defaults to span */
  readonly tagName?: keyof HTMLElementTagNameMap

  /** The html id of the element */
  readonly id?: string

  /**
   * An optional additional class name to set on the tooltip in order to be able
   * to apply specific styles to the tooltip
   */
  readonly tooltipClassName?: string

  /** An optional class name to set on the wrapper element */
  readonly className?: string

  /** Open on target focus */
  readonly openOnFocus?: boolean

  /** Whether or not an ancestor component is focused, used in case we want
   * the tooltip to be shown when it's focused. Examples of this are how we
   * want to show the tooltip for file status icons when files in the file
   * list are focused.
   */
  readonly ancestorFocused?: boolean
}

/**
 * A less complicated version of the Tooltip component for when it's acceptable
 * to add a wrapping element around the content. supports all the options that
 * the Tooltip component does without having to worry about refs.
 **/
export class TooltippedContent extends React.Component<React.PropsWithChildren<ITooltippedContentProps>> {
  private wrapperRef = createObservableRef<HTMLElement>()

  public render() {
    const { tooltip, tagName, children, className, tooltipClassName, ...rest } = this.props

    return React.createElement(tagName ?? "span", {
      id: this.props.id,
      ref: this.wrapperRef,
      className,
      // Preserve the original Desktop component contract.
      children: (
        <>
          {tooltip !== undefined && (
            <Tooltip target={this.wrapperRef} className={tooltipClassName} {...rest}>
              {tooltip}
            </Tooltip>
          )}
          {children}
        </>
      )
    })
  }
}
