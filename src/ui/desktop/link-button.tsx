// Desktop MIT port; platform imports adapted to Tauri.

import classNames from "classnames"
import * as React from "react"

import { shell } from "../../lib/app-shell"
import { createObservableRef } from "../../lib/ui/observable-ref"
import { Button as StandardButton } from "../base/button"
import { Tooltip } from "./tooltip"

interface ILinkButtonProps {
  /** A URI to open on click. */
  readonly uri?: string

  /** A function to call on click. */
  readonly onClick?: () => void

  /** A function to call when mouse is hovered over */
  readonly onMouseOver?: () => void

  /** A function to call when mouse is moved off */
  readonly onMouseOut?: () => void

  /** CSS classes attached to the component */
  readonly className?: string

  /** The tab index of the anchor element. */
  readonly tabIndex?: number

  /** Disable the link from being clicked */
  readonly disabled?: boolean

  /** title-text or tooltip for the link */
  readonly title?: string

  /** aria-label for the link */
  readonly ariaLabel?: string
}

/**
 * A link component.
 *
 * Provide `children` elements for the title of the rendered hyperlink.
 */
// Preserve the original Desktop component contract.
export class LinkButton extends React.Component<React.PropsWithChildren<ILinkButtonProps>, Record<string, never>> {
  private readonly anchorRef = createObservableRef<HTMLAnchorElement>()

  public render() {
    const href = this.props.uri || ""
    /**
     * If this component is to open something external like a link, it should
     * have the role of link as is default by the <a> tag. If this component is
     * to be used as a button, it should have the role of button. Otherwise,
     * screen readers may be confused by the results of the click.
     * */
    const role = this.props.uri === undefined ? "button" : undefined
    const className = classNames("link-button-component", this.props.className)
    const { title } = this.props

    return (
      <StandardButton
        variant="link"
        size="sm"
        nativeButton={false}
        disabled={this.props.disabled}
        // 原版 `.link-button-component` 不设字号字重，随所在文字继承（提交警告里是 12px 正文）
        className={classNames("h-auto p-0 [font-size:inherit] [line-height:inherit] [font-weight:inherit]", className)}
        render={
          <a
            ref={this.anchorRef}
            href={href}
            onMouseOver={this.props.onMouseOver}
            onMouseOut={this.props.onMouseOut}
            onFocus={this.props.onMouseOver}
            onBlur={this.props.onMouseOut}
            onClick={this.onClick}
            tabIndex={this.props.tabIndex}
            aria-label={this.props.ariaLabel}
            role={role ?? "link"}
          />
        }>
        {title && <Tooltip target={this.anchorRef}>{title}</Tooltip>}
        {this.props.children}
      </StandardButton>
    )
  }

  private onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()

    if (this.props.disabled) {
      return
    }

    const uri = this.props.uri
    if (uri) {
      shell.openExternal(uri)
    }

    const onClick = this.props.onClick
    if (onClick) {
      onClick()
    }
  }
}
