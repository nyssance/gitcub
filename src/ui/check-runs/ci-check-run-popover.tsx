import type { Disposable } from "event-kit"
// Desktop bebc062 MIT port. Native dispatcher and standard controls are platform adapters.
import * as React from "react"

import type { IAPIWorkflowJobStep } from "../../lib/api"
import { APICheckConclusion, APICheckStatus } from "../../lib/api"
import type { ICombinedRefCheck, IRefCheck } from "../../lib/ci-checks/ci-checks"
import { FailingCheckConclusions, getCheckRunStepURL, getCheckStatusCountMap } from "../../lib/ci-checks/ci-checks"
import { getCombinedStatusSummary } from "../../lib/ci-checks/status-summary"
import i18n from "../../lib/i18n"
import type { GitHubRepository } from "../../models/github-repository"
import { getPullRequestCommitRef } from "../../models/pull-request"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchorPosition, PopoverDecoration } from "../desktop/popover"
import { Donut } from "../donut"
import { Octicon, syncClockwise } from "../octicons"
import * as octicons from "../octicons/octicons.generated"
import { CICheckReRunButton } from "./ci-check-re-run-button"
import { CICheckRunList } from "./ci-check-run-list"
import type { ChecksDispatcher as Dispatcher } from "./native-checks-dispatcher"

const BlankSlateImage = "/static/empty-no-pull-requests.svg"

interface ICICheckRunPopoverProps {
  readonly error?: string | null
  readonly dispatcher: Dispatcher

  /** The GitHub repository to use when looking up commit status. */
  readonly repository: GitHubRepository

  /** The current branch name. */
  readonly branchName: string

  /** The pull request's number. */
  readonly prNumber: number

  readonly anchor: HTMLElement | null

  /** Callback for when popover closes */
  readonly closePopover: (event?: MouseEvent) => void
}

interface ICICheckRunPopoverState {
  readonly checkRuns: ReadonlyArray<IRefCheck>
  readonly checkRunSummary: string
  readonly loadingActionWorkflows: boolean
}

/** The CI Check Runs Popover. */
export class CICheckRunPopover extends React.PureComponent<ICICheckRunPopoverProps, ICICheckRunPopoverState> {
  private statusSubscription: Disposable | null = null

  public constructor(props: ICICheckRunPopoverProps) {
    super(props)

    const cachedStatus = this.props.dispatcher.tryGetCommitStatus(
      this.props.repository,
      getPullRequestCommitRef(this.props.prNumber)
    )

    this.state = {
      checkRuns: cachedStatus?.checks ?? [],
      checkRunSummary: this.getCombinedCheckSummary(cachedStatus),
      loadingActionWorkflows: true
    }
  }

  public componentDidMount() {
    const combinedCheck = this.props.dispatcher.tryGetCommitStatus(
      this.props.repository,
      getPullRequestCommitRef(this.props.prNumber),
      this.props.branchName
    )

    this.onStatus(combinedCheck)
    this.subscribe()
  }

  public componentWillUnmount() {
    this.unsubscribe()
  }

  private subscribe() {
    this.unsubscribe()

    this.statusSubscription = this.props.dispatcher.subscribeToCommitStatus(
      this.props.repository,
      getPullRequestCommitRef(this.props.prNumber),
      this.onStatus,
      this.props.branchName
    )
  }

  private unsubscribe() {
    if (this.statusSubscription) {
      this.statusSubscription.dispose()
      this.statusSubscription = null
    }
  }

  private onStatus = async (check: ICombinedRefCheck | null) => {
    if (check === null) {
      // Either this is on load -> we just want to continue to show loader
      // status/cached header or while user has it open and we ant to continue
      // to show last cache value to user closes popover
      return
    }

    this.setState({
      checkRuns: [...check.checks],
      checkRunSummary: this.getCombinedCheckSummary(check),
      loadingActionWorkflows: false
    })
  }

  private onViewCheckDetails = (checkRun: IRefCheck): void => {
    if (checkRun.htmlUrl === null && this.props.repository.htmlURL === null) {
      // A check run may not have a url depending on how it is setup.
      // However, the repository should have one; Thus, we shouldn't hit this
      return
    }

    // Some checks do not provide htmlURLS like ones for the legacy status
    // object as they do not have a view in the checks screen. In that case we
    // will just open the PR and they can navigate from there... a little
    // dissatisfying tho more of an edgecase anyways.
    const url = checkRun.htmlUrl ?? this.props.dispatcher.pullRequestUrl

    this.props.dispatcher.openInBrowser(url)
    this.props.dispatcher.incrementMetric("viewsCheckOnline")
  }

  private onViewJobStep = (checkRun: IRefCheck, step: IAPIWorkflowJobStep): void => {
    const { repository, prNumber, dispatcher } = this.props

    const url = getCheckRunStepURL(checkRun, step, repository, prNumber)

    if (url !== null) {
      dispatcher.openInBrowser(url)
      this.props.dispatcher.incrementMetric("viewsCheckJobStepOnline")
    }
  }

  private getCombinedCheckSummary(combinedCheck: ICombinedRefCheck | null): string {
    if (combinedCheck === null || combinedCheck.checks.length === 0) {
      return ""
    }
    return getCombinedStatusSummary(combinedCheck.checks, "check")
  }

  private rerunChecks = (failedOnly: boolean, checkRuns?: ReadonlyArray<IRefCheck>) => {
    this.props.dispatcher.showPopup({
      checkRuns: checkRuns ?? this.state.checkRuns,
      repository: this.props.repository,
      prRef: getPullRequestCommitRef(this.props.prNumber),
      failedOnly
    })
  }

  private renderRerunButton = () => {
    const { checkRuns } = this.state
    if (!this.props.dispatcher.supportsRerun) {
      return null
    }

    return (
      <CICheckReRunButton
        disabled={checkRuns.length === 0 || this.state.loadingActionWorkflows}
        checkRuns={checkRuns}
        canReRunFailed={this.props.dispatcher.supportsIndividualRerun}
        onRerunChecks={this.rerunChecks}
      />
    )
  }

  private renderCheckRunLoadings(): React.JSX.Element {
    return (
      <div className="loading-check-runs">
        <img src={BlankSlateImage} className="blankslate-image" alt="" />
        <div className="title">{i18n.t("ci.standBy")}</div>
        <div className="call-to-action">{i18n.t("ci.incoming")}</div>
      </div>
    )
  }

  private renderCompletenessIndicator(
    allSuccess: boolean,
    allFailure: boolean,
    loading: boolean,
    checkRuns: ReadonlyArray<IRefCheck>
  ): React.JSX.Element {
    if (loading) {
      return <Octicon symbol={syncClockwise} className="spin" />
    }

    switch (true) {
      case allSuccess:
        return <Octicon className={"completeness-indicator-success"} symbol={octicons.checkCircleFill} />
      case allFailure: {
        return <Octicon className={"completeness-indicator-error"} symbol={octicons.xCircleFill} />
      }
    }

    const valueMap = getCheckStatusCountMap(checkRuns)

    const ariaLabel = `Completeness indicator. ${
      valueMap.get(APICheckStatus.Completed) ?? 0
    } completed, ${valueMap.get(APICheckStatus.InProgress) ?? 0} in progress, ${
      valueMap.get(APICheckStatus.Queued) ?? 0
    } queued.`

    return <Donut ariaLabel={ariaLabel} valueMap={valueMap} />
  }

  private getTitle(
    allSuccess: boolean,
    allFailure: boolean,
    somePendingNoFailures: boolean,
    loading: boolean
  ): React.JSX.Element {
    switch (true) {
      case loading:
        return <>{i18n.t("ci.summary")}</>
      case somePendingNoFailures:
        return <span className="pending">{i18n.t("ci.pending")}</span>
      case allFailure:
        return <span className="failure">{i18n.t("ci.failed")}</span>
      case allSuccess:
        return <>{i18n.t("ci.passed")}</>
    }

    return <span className="failure">{i18n.t("ci.mixed")}</span>
  }

  private renderHeader = (): React.JSX.Element => {
    const { loadingActionWorkflows, checkRuns, checkRunSummary } = this.state
    // Only show loading header status, if there are no cached check runs to display.
    const loading = loadingActionWorkflows && checkRuns.length === 0

    const somePendingNoFailures =
      !loading &&
      checkRuns.some(v => v.conclusion === null) &&
      !checkRuns.some(v => v.conclusion !== null && FailingCheckConclusions.includes(v.conclusion))

    const successfulishConclusions = [
      APICheckConclusion.Success,
      APICheckConclusion.Neutral,
      APICheckConclusion.Skipped
    ]
    const allSuccessIsh =
      !loading && // quick return: if loading, no list
      !somePendingNoFailures && // quick return: if some pending, can't all be success
      !checkRuns.some(v => v.conclusion !== null && !successfulishConclusions.includes(v.conclusion))

    const allFailure =
      !loading && // quick return if loading, no list
      !somePendingNoFailures && // quick return: if some failing, can't all be failure
      !checkRuns.some(v => v.conclusion === null || !FailingCheckConclusions.includes(v.conclusion))

    return (
      <div className="ci-check-run-list-header">
        <div className="completeness-indicator">
          {this.renderCompletenessIndicator(allSuccessIsh, allFailure, loading, checkRuns)}
        </div>
        <div className="ci-check-run-list-title-container">
          <h1 id="ci-check-run-header" className="title">
            {this.getTitle(allSuccessIsh, allFailure, somePendingNoFailures, loading)}
          </h1>
          <div className="check-run-list-summary">{checkRunSummary}</div>
        </div>
        {this.renderRerunButton()}
      </div>
    )
  }

  private onRerunJob = (check: IRefCheck) => {
    this.rerunChecks(false, [check])
  }

  public renderList = (): React.JSX.Element => {
    const { checkRuns, loadingActionWorkflows } = this.state
    if (this.props.error)
      return (
        <Alert variant="destructive">
          <AlertDescription>{this.props.error}</AlertDescription>
          <Button variant="outline" onClick={() => void this.props.dispatcher.refresh()}>
            {i18n.t("inbox.refresh")}
          </Button>
        </Alert>
      )
    if (loadingActionWorkflows) {
      return this.renderCheckRunLoadings()
    }

    return (
      <div className="ci-check-run-list-container">
        <CICheckRunList
          checkRuns={checkRuns}
          onViewCheckDetails={this.onViewCheckDetails}
          onViewJobStep={this.onViewJobStep}
          onRerunJob={this.props.dispatcher.supportsIndividualRerun ? this.onRerunJob : undefined}
        />
      </div>
    )
  }

  public render() {
    return (
      <div className="ci-check-list-popover">
        <Popover
          anchor={this.props.anchor}
          className="desktop-ci-popover w-[440px] gap-0 p-0"
          anchorPosition={PopoverAnchorPosition.Bottom}
          decoration={PopoverDecoration.Balloon}
          ariaLabelledby="ci-check-run-header"
          onClickOutside={this.props.closePopover}>
          <div className="ci-check-run-list-wrapper">
            {this.renderHeader()}
            {this.renderList()}
          </div>
        </Popover>
      </div>
    )
  }
}
