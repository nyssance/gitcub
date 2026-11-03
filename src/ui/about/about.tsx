// Desktop MIT port; platform imports adapted to Tauri.
// GitCub 差异：更新照 ALwith Desktop（@alwith/module-desktop-shell），没有手动检查，状态与安装在侧栏底部的更新卡片里，
// 所以这里不渲染 Desktop 的更新状态、检查按钮与更新错误。
import * as React from "react"

import { development as __DEV__, releaseChannel as __RELEASE_CHANNEL__ } from "../../lib/build-environment"
import { DefaultDialogFooter, Dialog, DialogContent } from "../desktop/dialog"
import { LinkButton } from "../desktop/link-button"
import { Row } from "../desktop/row"

const ReleaseNotesUri = "https://github.com/nyssance/gitcub/releases"

const DesktopLogo = "/icon.png"

interface IAboutProps {
  /**
   * Event triggered when the dialog is dismissed by the user in the
   * ways described in the Dialog component's dismissible prop.
   */
  readonly onDismissed: () => void

  /**
   * The name of the currently installed (and running) application
   */
  readonly applicationName: string

  /**
   * The currently installed (and running) version of the app.
   */
  readonly applicationVersion: string

  /**
   * The currently installed (and running) architecture of the app.
   */
  readonly applicationArchitecture: string

  readonly onShowAcknowledgements: () => void

  /** A function to call when the user wants to see Terms and Conditions. */
  readonly onShowTermsAndConditions: () => void
}

/**
 * A dialog that presents information about the
 * running application such as name and version.
 */
export class About extends React.Component<IAboutProps> {
  private renderBetaLink() {
    if (__RELEASE_CHANNEL__ === "beta") {
      return
    }

    return (
      <div>
        <p className="no-padding">Looking for the latest features?</p>
        <p className="no-padding">
          Check out the <LinkButton uri="https://desktop.github.com/beta">Beta Channel</LinkButton>
        </p>
      </div>
    )
  }

  public render() {
    const name = this.props.applicationName
    const version = this.props.applicationVersion
    const releaseNotesLink = <LinkButton uri={ReleaseNotesUri}>release notes</LinkButton>

    const versionText = __DEV__ ? `Build ${version}` : `Version ${version}`
    const titleId = "Dialog_about"

    return (
      <Dialog id="about" titleId={titleId} onSubmit={this.props.onDismissed} onDismissed={this.props.onDismissed}>
        <DialogContent className="flex flex-col items-center gap-4 text-center">
          <Row className="logo justify-center">
            <img src={DesktopLogo} alt={name} width="64" height="64" />
          </Row>
          <h1 className="text-lg font-semibold" id={titleId}>
            About {name}
          </h1>
          <p className="no-padding">
            <span className="selectable-text">
              {versionText} ({this.props.applicationArchitecture})
            </span>{" "}
            ({releaseNotesLink})
          </p>
          <LinkButton uri="https://github.com/nyssance">GitHub · @nyssance</LinkButton>
          {this.renderBetaLink()}
          <div className="terms-and-license-container flex flex-col gap-2 text-sm">
            <p className="no-padding terms-and-license">
              <LinkButton onClick={this.props.onShowTermsAndConditions}>Terms and Conditions</LinkButton>
            </p>
            <p className="no-padding terms-and-license">
              <LinkButton onClick={this.props.onShowAcknowledgements}>License and Open Source Notices</LinkButton>
            </p>
          </div>
        </DialogContent>
        <DefaultDialogFooter />
      </Dialog>
    )
  }
}
