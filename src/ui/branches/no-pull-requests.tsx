// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"
import { Trans } from "react-i18next"

import i18n from "../../lib/i18n"
import { LinkButton } from "../desktop/link-button"
import { Ref } from "../desktop/ref"

const BlankSlateImage = "/static/empty-no-pull-requests.svg"

interface INoPullRequestsProps {
  /** The name of the repository. */
  readonly repositoryName: string

  /** Is the default branch currently checked out? */
  readonly isOnDefaultBranch: boolean

  /** Is this component being rendered due to a search? */
  readonly isSearch: boolean

  /* Called when the user wants to create a new branch. */
  readonly onCreateBranch: () => void

  /** Called when the user wants to create a pull request. */
  readonly onCreatePullRequest: () => void

  /** Are we currently loading pull requests? */
  readonly isLoadingPullRequests: boolean
}

/** The placeholder for when there are no open pull requests. */
// Preserve the original Desktop component contract.
export class NoPullRequests extends React.Component<INoPullRequestsProps, Record<string, never>> {
  public render() {
    return (
      <div className="no-pull-requests">
        <img src={BlankSlateImage} className="blankslate-image" alt="" />
        {this.renderTitle()}
        {this.renderCallToAction()}
      </div>
    )
  }

  private renderTitle() {
    if (this.props.isSearch) {
      return <div className="title">{i18n.t("desktopUI.cantFindThatPullRequest")}</div>
    } else if (this.props.isLoadingPullRequests) {
      return <div className="title">{i18n.t("desktopUI.hangTight")}</div>
    } else {
      return (
        <div>
          <div className="title">{i18n.t("desktopUI.youreAllSet")}</div>
          <div className="no-prs">
            {i18n.t("desktopUI.noOpenPullRequestsIn")} <Ref>{this.props.repositoryName}</Ref>
          </div>
        </div>
      )
    }
  }

  private renderCallToAction() {
    if (this.props.isLoadingPullRequests) {
      return <div className="call-to-action">{i18n.t("desktopUI.loadingPullRequestsAsFastAsICan")}</div>
    }

    if (this.props.isOnDefaultBranch) {
      return (
        <div className="call-to-action">
          <Trans
            i18nKey="desktopUI.wouldYouLikeToCreateANewBranch"
            components={[<LinkButton key="link" onClick={this.props.onCreateBranch} />]}
          />
        </div>
      )
    } else {
      return (
        <div className="call-to-action">
          <Trans
            i18nKey="desktopUI.wouldYouLikeToCreateAPullRequest"
            components={[<LinkButton key="link" onClick={this.props.onCreatePullRequest} />]}
          />
        </div>
      )
    }
  }
}
