import classNames from "classnames"
// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { Button as StandardButton } from "@/components/ui/button"

import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"

interface IBannerProps {
  readonly id?: string
  readonly timeout?: number
  readonly dismissable?: boolean
  readonly className?: string
  readonly onDismissed: () => void
}

// Preserve the original Desktop implementation and contract.
export class Banner extends React.Component<React.PropsWithChildren<IBannerProps>, Record<string, never>> {
  private banner = React.createRef<HTMLDivElement>()

  // Timeout ID for manual focus placement after mounting
  private focusTimeoutId: number | null = null

  // Timeout ID for auto-dismissal of the banner after focus is lost
  private dismissalTimeoutId: number | null = null

  public render() {
    const cn = classNames("banner", this.props.className)
    return (
      <div id={this.props.id} className={cn} ref={this.banner}>
        <div className="contents">{this.props.children}</div>
        {this.renderCloseButton()}
      </div>
    )
  }

  private renderCloseButton() {
    const { dismissable, onDismissed } = this.props

    if (dismissable === false) {
      return null
    }

    return (
      <div className="close">
        <StandardButton variant="ghost" onClick={onDismissed} aria-label="Dismiss this message">
          <Octicon symbol={octicons.x} />
        </StandardButton>
      </div>
    )
  }

  public componentDidMount() {
    this.focusTimeoutId = window.setTimeout(() => {
      this.focusOnFirstSuitableElement()
    }, 200)
    this.addDismissalFocusListeners()
  }

  public componentWillUnmount() {
    if (this.focusTimeoutId !== null) {
      window.clearTimeout(this.focusTimeoutId)
      this.focusTimeoutId = null
    }

    this.removeDismissalFocusListeners()
  }

  private focusOnFirstSuitableElement = () => {
    const target = this.banner.current?.querySelector("a") ?? this.banner.current?.querySelector("button")
    target?.focus()
  }

  private addDismissalFocusListeners() {
    this.banner.current?.addEventListener("focusin", this.onFocusIn)
    this.banner.current?.addEventListener("focusout", this.onFocusOut)
  }

  private removeDismissalFocusListeners() {
    this.banner.current?.removeEventListener("focusout", this.onFocusOut)
    this.banner.current?.removeEventListener("focusin", this.onFocusIn)
  }

  private onFocusIn = () => {
    if (this.dismissalTimeoutId !== null) {
      window.clearTimeout(this.dismissalTimeoutId)
      this.dismissalTimeoutId = null
    }
  }

  private onFocusOut = async (event: FocusEvent) => {
    const { dismissable, onDismissed, timeout } = this.props

    if (event.relatedTarget && this.banner.current?.contains(event.relatedTarget as Node)) {
      return
    }

    if (dismissable !== false && timeout !== undefined) {
      this.dismissalTimeoutId = window.setTimeout(() => {
        onDismissed()
      }, timeout)
    }
  }
}
