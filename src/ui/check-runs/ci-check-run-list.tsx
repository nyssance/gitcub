import classNames from "classnames"
// Desktop bebc062 MIT port. Native dispatcher and standard controls are platform adapters.
import * as React from "react"

import type { IAPIWorkflowJobStep } from "../../lib/api"
import type { IRefCheck } from "../../lib/ci-checks/ci-checks"
import {
  getCheckRunGroupNames,
  getCheckRunsGroupedByActionWorkflowNameAndEvent,
  isFailure
} from "../../lib/ci-checks/ci-checks"
import { FocusContainer } from "../desktop/focus-container"
import { CICheckRunListItem } from "./ci-check-run-list-item"

interface ICICheckRunListProps {
  /** List of check runs to display */
  readonly checkRuns: ReadonlyArray<IRefCheck>

  /** Whether check runs can be selected. Default: false */
  readonly selectable?: boolean

  /** Whether check runs can be expanded. Default: false */
  readonly notExpandable?: boolean

  /** Showing a condensed view */
  readonly isCondensedView?: boolean

  /** Whether the check run status has a tooltip */
  readonly hasStatusTooltip?: boolean

  /** Callback to opens check runs target url (maybe GitHub, maybe third party) */
  readonly onViewCheckDetails?: (checkRun: IRefCheck) => void

  /** Callback when a check run is clicked */
  readonly onCheckRunClick?: (checkRun: IRefCheck) => void

  /** Callback to open a job steps link on dotcom*/
  readonly onViewJobStep?: (checkRun: IRefCheck, step: IAPIWorkflowJobStep) => void

  /** Callback to rerun a job*/
  readonly onRerunJob?: (checkRun: IRefCheck) => void
}

interface ICICheckRunListState {
  readonly checkRunGroups: Map<string, ReadonlyArray<IRefCheck>>
  readonly checkRunExpanded: string | null
  readonly hasUserToggledCheckRun: boolean
}

/** The CI Check list. */
export class CICheckRunList extends React.PureComponent<ICICheckRunListProps, ICICheckRunListState> {
  public constructor(props: ICICheckRunListProps) {
    super(props)
    this.state = this.setupStateAfterCheckRunPropChange(this.props, null)
  }

  public componentDidUpdate(prevProps: ICICheckRunListProps) {
    if (prevProps.checkRuns === this.props.checkRuns && prevProps.notExpandable === this.props.notExpandable) return
    // Polling may change steps, workflow grouping, or membership without changing
    // status. Always refresh data; preserve only the user's expansion choice.
    this.setState(this.setupStateAfterCheckRunPropChange(this.props, this.state))
  }

  private setupStateAfterCheckRunPropChange(
    props: ICICheckRunListProps,
    currentState: ICICheckRunListState | null
  ): ICICheckRunListState {
    // If the user has expanded something and then a load occurs, we don't want
    // to reset their position.
    if (currentState?.hasUserToggledCheckRun === true) {
      return {
        ...currentState,
        checkRunGroups: getCheckRunsGroupedByActionWorkflowNameAndEvent(props.checkRuns),
        checkRunExpanded:
          props.notExpandable || !props.checkRuns.some(cr => cr.id.toString() === currentState.checkRunExpanded)
            ? null
            : currentState.checkRunExpanded
      }
    }

    const checkRunGroups = getCheckRunsGroupedByActionWorkflowNameAndEvent(props.checkRuns)
    let checkRunExpanded = null

    if (props.notExpandable !== true) {
      // If there is a failure, we want the first check run with a failure, to
      // be opened so the user doesn't have to click through to find it.
      for (const group of checkRunGroups.values()) {
        const firstFailure = group.find(cr => isFailure(cr) && cr.actionJobSteps !== undefined)
        if (firstFailure !== undefined) {
          checkRunExpanded = firstFailure.id.toString()
          break
        }
      }
    }

    return {
      checkRunGroups,
      checkRunExpanded,
      hasUserToggledCheckRun: currentState?.hasUserToggledCheckRun || false
    }
  }

  private onCheckRunClick = (checkRun: IRefCheck): void => {
    if (this.props.notExpandable === true) {
      return
    }

    // If the list is selectable, we don't want to toggle when the selected
    // item is clicked again.
    const checkRunExpanded =
      this.state.checkRunExpanded === checkRun.id.toString() && !this.props.selectable ? null : checkRun.id.toString()

    this.setState({
      checkRunExpanded,
      hasUserToggledCheckRun: true
    })

    this.props.onCheckRunClick?.(checkRun)
  }

  private renderListItems = (checkRuns: ReadonlyArray<IRefCheck> | undefined) => {
    if (checkRuns === undefined) {
      // This shouldn't happen as the selection is based off the keys of the map
      return null
    }

    const list = checkRuns.map(c => {
      const checkRunExpanded = this.state.checkRunExpanded === c.id.toString()
      const selectable = this.props.selectable === true

      return (
        <CICheckRunListItem
          checkRun={c}
          key={c.id}
          selectable={selectable}
          selected={selectable && checkRunExpanded}
          // Only expand check runs if the list is not selectable
          isCheckRunExpanded={!selectable && checkRunExpanded}
          notExpandable={this.props.notExpandable}
          onCheckRunExpansionToggleClick={this.onCheckRunClick}
          onViewCheckExternally={this.props.onViewCheckDetails}
          onViewJobStep={this.props.onViewJobStep}
          onRerunJob={this.props.onRerunJob}
          isCondensedView={this.props.isCondensedView}
          isHeader={false}
          hasStatusTooltip={this.props.hasStatusTooltip}
        />
      )
    })

    return <FocusContainer className="list-focus-container">{list}</FocusContainer>
  }

  private renderList = (): React.JSX.Element | null => {
    const { checkRunGroups } = this.state
    const checkRunGroupNames = getCheckRunGroupNames(checkRunGroups)
    if (checkRunGroupNames.length === 1 && (checkRunGroupNames[0] === "Other" || this.props.isCondensedView)) {
      return this.renderListItems(this.props.checkRuns)
    }

    const groupHeaderClasses = classNames("ci-check-run-list-group-header", {
      condensed: this.props.isCondensedView
    })

    const groups = checkRunGroupNames.map((groupName, i) => {
      return (
        <div className="ci-check-run-list-group" key={i}>
          <h2 className={groupHeaderClasses}>{groupName}</h2>
          {this.renderListItems(checkRunGroups.get(groupName))}
        </div>
      )
    })

    return <>{groups}</>
  }

  public render() {
    return <div className="ci-check-run-list">{this.renderList()}</div>
  }
}
