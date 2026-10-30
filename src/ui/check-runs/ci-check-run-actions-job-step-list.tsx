/* eslint-disable react/no-did-update-set-state -- Preserve Desktop state synchronization. */
// Desktop MIT port; original job-step rendering and navigation behavior.
import * as React from "react"

import type { IAPIWorkflowJobStep } from "../../lib/api"
import { isFailure } from "../../lib/ci-checks/ci-checks"
import { Stepper, StepperItem } from "../reui/stepper"
import { CICheckRunActionsJobStepListItem } from "./ci-check-run-actions-job-step-item"

interface ICICheckRunActionsJobStepListsProps {
  /** The action jobs steps of a check run **/
  readonly steps: ReadonlyArray<IAPIWorkflowJobStep>

  /** Callback to open a job steps link on dotcom*/
  readonly onViewJobStep: (step: IAPIWorkflowJobStep) => void
}

interface ICICheckRunActionsJobStepListsState {
  readonly firstFailedStep: IAPIWorkflowJobStep | undefined
}

/** The CI check list item. */
export class CICheckRunActionsJobStepList extends React.PureComponent<
  ICICheckRunActionsJobStepListsProps,
  ICICheckRunActionsJobStepListsState
> {
  public constructor(props: ICICheckRunActionsJobStepListsProps) {
    super(props)

    this.state = {
      firstFailedStep: this.props.steps.find(isFailure)
    }
  }

  public componentDidUpdate() {
    this.setState({
      firstFailedStep: this.props.steps.find(isFailure)
    })
  }

  public render() {
    const { steps } = this.props

    return (
      <Stepper
        value={0}
        orientation="vertical"
        role="list"
        aria-orientation={undefined}
        className="ci-check-run-job-steps-list">
        {steps.map(step => (
          <StepperItem key={step.number} step={step.number} completed={step.conclusion === "success"}>
            <CICheckRunActionsJobStepListItem
              step={step}
              firstFailedStep={this.state.firstFailedStep}
              onViewJobStepExternally={this.props.onViewJobStep}
            />
          </StepperItem>
        ))}
      </Stepper>
    )
  }
}
