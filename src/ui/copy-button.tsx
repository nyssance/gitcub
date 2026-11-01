// Desktop MIT port; platform imports adapted to Tauri.
import React from "react"

import { sleep } from "../upstream/lib/promise"
import { AriaLiveContainer } from "./accessibility/aria-live-container"
import { writeClipboardText } from "./desktop-window-proxy"
import { Button } from "./desktop/button"
import { Octicon } from "./octicons"
import * as octicons from "./octicons/octicons.generated"

interface ICopyButtonProps {
  readonly copyContent: string
  readonly ariaLabel: string
  readonly className?: string
}

interface ICopyButtonState {
  readonly showCopied: boolean
}

export class CopyButton extends React.Component<ICopyButtonProps, ICopyButtonState> {
  public constructor(props: ICopyButtonProps) {
    super(props)

    this.state = {
      showCopied: false
    }
  }

  private onCopy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    if (!(await writeClipboardText(this.props.copyContent))) {
      return
    }

    this.setState({ showCopied: true })

    await sleep(2000)

    this.setState({ showCopied: false })
  }

  public renderSymbol() {
    const { showCopied } = this.state

    const symbol = showCopied ? octicons.check : octicons.copy

    return <Octicon symbol={symbol} height={24} />
  }

  public render() {
    const { ariaLabel } = this.props
    const { showCopied } = this.state

    const copiedMessage = "Copied!"
    const ariaMessage = showCopied ? copiedMessage : null
    return (
      <Button
        className={this.props.className ? `copy-button ${this.props.className}` : "copy-button"}
        tooltip={showCopied ? copiedMessage : ariaLabel}
        ariaLabel={ariaLabel}
        onClick={this.onCopy}
        openTooltipOnClick={true}
        applyTooltipAriaDescribedBy={false}>
        {this.renderSymbol()}
        <AriaLiveContainer message={ariaMessage} trackedUserInput={showCopied} />
      </Button>
    )
  }
}
