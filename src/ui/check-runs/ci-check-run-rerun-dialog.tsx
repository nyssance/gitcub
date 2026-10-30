// Desktop bebc062 MIT port. Native dispatcher and standard controls are platform adapters.
import * as React from "react"

import { APICheckConclusion } from "../../lib/api"
import type { IRefCheck } from "../../lib/ci-checks/ci-checks"
import i18n from "../../lib/i18n"
import type { GitHubRepository } from "../../models/github-repository"
import { Button } from "../base/button"
import { Dialog, DialogContent, DialogFooter } from "../desktop/dialog"
import { OkCancelButtonGroup } from "../desktop/dialog/ok-cancel-button-group"
import { Octicon } from "../octicons"
import * as octicons from "./../octicons/octicons.generated"
import { CICheckRunList } from "./ci-check-run-list"
import type { ChecksDispatcher as Dispatcher } from "./native-checks-dispatcher"

const BlankSlateImage = "/static/empty-no-pull-requests.svg"

interface ICICheckRunRerunDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: GitHubRepository

  /** List of all the check runs (some of which are not rerunnable) */
  readonly checkRuns: ReadonlyArray<IRefCheck>

  /** The git reference of the pr */
  readonly prRef: string

  /** Whether to only rerun failed checks */
  readonly failedOnly: boolean

  readonly onDismissed: () => void
}

interface ICICheckRunRerunDialogState {
  readonly loadingCheckSuites: boolean
  readonly error: string | null
  readonly loadingRerun: boolean
  readonly rerunnable: ReadonlyArray<IRefCheck>
  readonly nonRerunnable: ReadonlyArray<IRefCheck>
}

/**
 * Dialog that informs the user of which jobs will be rerun
 */
export class CICheckRunRerunDialog extends React.Component<ICICheckRunRerunDialogProps, ICICheckRunRerunDialogState> {
  public constructor(props: ICICheckRunRerunDialogProps) {
    super(props)
    this.state = {
      error: null,
      loadingCheckSuites: true,
      loadingRerun: false,
      rerunnable: [],
      nonRerunnable: []
    }
    void this.determineRerunnability()
  }

  private onSubmit = async () => {
    if (this.state.loadingRerun || this.state.loadingCheckSuites || this.state.rerunnable.length === 0) return
    const { dispatcher, repository, prRef } = this.props
    this.setState({ loadingRerun: true })
    try {
      await dispatcher.rerequestCheckSuites(repository, this.state.rerunnable, this.props.failedOnly)
      await dispatcher.manualRefreshSubscription(repository, prRef, this.state.rerunnable)
      dispatcher.incrementMetric("rerunsChecks")
      this.props.onDismissed()
    } catch (error) {
      this.setState({ loadingRerun: false, error: String(error) })
    }
  }

  private determineRerunnability = async () => {
    const checkRunsToConsider = this.props.failedOnly
      ? this.props.checkRuns.filter(cr => cr.conclusion === APICheckConclusion.Failure)
      : this.props.checkRuns

    // Eligibility comes from the platform adapter: GitHub suite metadata or GitLab job capability.
    if (!this.state.loadingCheckSuites) this.setState({ error: null, loadingCheckSuites: true })
    try {
      const eligibility = await this.props.dispatcher.canRerunChecks(checkRunsToConsider)
      const rerunnable = checkRunsToConsider.filter(check => eligibility.has(check.id))
      const nonRerunnable = checkRunsToConsider.filter(check => !eligibility.has(check.id))

      this.setState({ loadingCheckSuites: false, rerunnable, nonRerunnable })
    } catch (error) {
      this.setState({ loadingCheckSuites: false, error: String(error) })
    }
  }

  private renderRerunnableJobsList = () => {
    if (this.state.rerunnable.length === 0) {
      return null
    }

    return (
      <div className="ci-check-run-list check-run-rerun-list">
        <CICheckRunList
          checkRuns={this.state.rerunnable}
          notExpandable={true}
          isCondensedView={true}
          hasStatusTooltip={true}
        />
      </div>
    )
  }

  private renderRerunDependentsMessage = () => {
    if (this.state.rerunnable.length === 0) {
      return null
    }

    return <div className="re-run-dependents-message">{i18n.t("ci.dependents")}</div>
  }

  private renderRerunWarning = () => {
    if (this.state.loadingCheckSuites || this.state.nonRerunnable.length === 0) {
      return null
    }

    return (
      <div className="non-re-run-info warning-helper-text">
        <Octicon symbol={octicons.alert} />
        {i18n.t(this.state.rerunnable.length ? "ci.unavailable" : "ci.noneRerunnable")}
      </div>
    )
  }

  public getTitle = (showDescriptor: boolean = true) => {
    return i18n.t(
      showDescriptor && this.props.failedOnly
        ? "ci.rerunFailed"
        : showDescriptor && this.props.checkRuns.length === 1
          ? "ci.rerunSingle"
          : "ci.rerunChecks"
    )
  }

  private renderDialogContent = () => {
    if (this.state.loadingCheckSuites && this.props.checkRuns.length > 1) {
      return (
        <div className="loading-rerun-checks">
          <img src={BlankSlateImage} className="blankslate-image" alt="" />
          <div className="title">{i18n.t("ci.wait")}</div>
          <div className="call-to-action">Determining which checks can be re-run.</div>
        </div>
      )
    }

    return (
      <>
        {this.renderRerunDependentsMessage()}
        {this.renderRerunnableJobsList()}
        {this.renderRerunWarning()}
      </>
    )
  }

  public render() {
    return (
      <Dialog
        id="rerun-check-runs"
        title={this.getTitle()}
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        loading={this.state.loadingCheckSuites || this.state.loadingRerun}
        disabled={this.state.loadingRerun}
        dismissDisabled={this.state.loadingRerun}>
        <DialogContent>
          {this.state.error && (
            <div role="alert">
              {this.state.error}
              <Button type="button" variant="outline" onClick={() => void this.determineRerunnability()}>
                {i18n.t("inbox.refresh")}
              </Button>
            </div>
          )}
          {this.renderDialogContent()}
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={this.getTitle(false)}
            okButtonDisabled={this.state.rerunnable.length === 0}
          />
        </DialogFooter>
      </Dialog>
    )
  }
}
