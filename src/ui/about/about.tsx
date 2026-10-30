// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { development as __DEV__, releaseChannel as __RELEASE_CHANNEL__ } from "../../lib/build-environment"
import { __LINUX__ } from "../../lib/platform-flags"
import { type IUpdateState, UpdateStatus } from "../../lib/ui/update-store"
import { assertNever } from "../../upstream/lib/fatal-error"
import { Button } from "../desktop/button"
import { DefaultDialogFooter, Dialog, DialogContent, DialogError } from "../desktop/dialog"
import { LinkButton } from "../desktop/link-button"
import { Loading } from "../desktop/loading"
import { Row } from "../desktop/row"
import { RelativeTime } from "../relative-time"

const ReleaseNotesUri = "https://github.com/nyssance/gitcub/releases"

import { formatDate } from "../../lib/format-date"
import { isWindowsAndNoLongerSupportedByElectron } from "../../lib/get-os"
import { AriaLiveContainer } from "../accessibility/aria-live-container"

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

  /** A function to call to kick off a non-staggered update check. */
  readonly onCheckForNonStaggeredUpdates: () => void

  readonly onShowAcknowledgements: () => void

  /** A function to call when the user wants to see Terms and Conditions. */
  readonly onShowTermsAndConditions: () => void
  readonly onQuitAndInstall: () => void

  readonly updateState: IUpdateState

  /**
   * A flag to indicate whether the About dialog should ignore that
   * it's running in development mode. Used exclusively by the AboutTestDialog
   */
  readonly allowDevelopment?: boolean
}

interface IUpdateInfoProps {
  readonly message: string
  readonly richMessage?: React.JSX.Element
  readonly loading?: boolean
}

class UpdateInfo extends React.Component<IUpdateInfoProps> {
  public render() {
    return (
      <div className="update-status text-muted-foreground flex items-center justify-center gap-2 text-sm">
        <AriaLiveContainer message={this.props.message} />

        {this.props.loading && <Loading />}
        {this.props.richMessage ?? this.props.message}
      </div>
    )
  }
}

/**
 * A dialog that presents information about the
 * running application such as name and version.
 */
export class About extends React.Component<IAboutProps> {
  private get canCheckForUpdates() {
    return __RELEASE_CHANNEL__ !== "development" || this.props.allowDevelopment === true
  }

  private renderUpdateButton() {
    if (!this.canCheckForUpdates) {
      return null
    }

    const updateStatus = this.props.updateState.status

    switch (updateStatus) {
      case UpdateStatus.UpdateReady:
        return (
          <Row className="justify-center">
            <Button onClick={this.props.onQuitAndInstall}>Quit and Install Update</Button>
          </Row>
        )
      case UpdateStatus.UpdateNotAvailable:
      case UpdateStatus.CheckingForUpdates:
      case UpdateStatus.UpdateAvailable:
      case UpdateStatus.UpdateNotChecked: {
        const disabled =
          ![UpdateStatus.UpdateNotChecked, UpdateStatus.UpdateNotAvailable].includes(updateStatus) ||
          isWindowsAndNoLongerSupportedByElectron()

        const buttonTitle = "Check for Updates"

        return (
          <Row className="justify-center">
            <Button disabled={disabled} onClick={this.props.onCheckForNonStaggeredUpdates}>
              {buttonTitle}
            </Button>
          </Row>
        )
      }
      default:
        return assertNever(updateStatus, `Unknown update status ${updateStatus}`)
    }
  }

  private renderUpdateDetails() {
    if (__LINUX__) {
      return null
    }

    if (!this.canCheckForUpdates) {
      return <p>The application is currently running in development and will not receive any updates.</p>
    }

    const { status, lastSuccessfulCheck } = this.props.updateState

    switch (status) {
      case UpdateStatus.CheckingForUpdates:
        return <UpdateInfo message="Checking for updates…" loading={true} />
      case UpdateStatus.UpdateAvailable:
        return <UpdateInfo message="Downloading update…" loading={true} />
      case UpdateStatus.UpdateNotAvailable: {
        if (!lastSuccessfulCheck) {
          return null
        }

        const richMessage = (
          <p>
            You have the latest version (last checked <RelativeTime date={lastSuccessfulCheck} />)
          </p>
        )

        const absoluteDate = formatDate(lastSuccessfulCheck, {
          dateStyle: "full",
          timeStyle: "short"
        })

        return (
          <UpdateInfo
            message={`You have the latest version (last checked ${absoluteDate})`}
            richMessage={richMessage}
          />
        )
      }
      case UpdateStatus.UpdateReady:
        return <UpdateInfo message="An update has been downloaded and is ready to be installed." />
      case UpdateStatus.UpdateNotChecked:
        return null
      default:
        return assertNever(status, `Unknown update status ${status}`)
    }
  }

  private renderUpdateErrors() {
    if (__LINUX__) {
      return null
    }

    if (!this.canCheckForUpdates) {
      return null
    }

    if (isWindowsAndNoLongerSupportedByElectron()) {
      return (
        <DialogError>
          This operating system is no longer supported. Software updates have been disabled.{" "}
          <LinkButton uri="https://docs.github.com/en/desktop/installing-and-configuring-github-desktop/overview/supported-operating-systems">
            Supported operating systems
          </LinkButton>
        </DialogError>
      )
    }

    if (!this.props.updateState.lastSuccessfulCheck) {
      return (
        <DialogError>
          Couldn't determine the last time an update check was performed. You may be running an old version. Please try
          manually checking for updates and contact GitHub Support if the problem persists
        </DialogError>
      )
    }

    return null
  }

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
        {this.renderUpdateErrors()}
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
          {this.renderUpdateDetails()}
          {this.renderUpdateButton()}
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
