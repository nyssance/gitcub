// Desktop MIT port; original job-step rendering and navigation behavior.

import classNames from "classnames"
import * as React from "react"

import type { IAPIWorkflowJobStep } from "../../lib/api"
import { getFormattedCheckRunDuration, getFormattedCheckRunLongDuration } from "../../lib/ci-checks/ci-checks"
import i18n from "../../lib/i18n"
import { getClassNameForCheck, getSymbolForLogStep } from "../branches/ci-status"
import { Button } from "../desktop/button"
import { TooltipDirection } from "../desktop/tooltip"
import { TooltippedContent } from "../desktop/tooltipped-content"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"
import { StepperIndicator } from "../reui/stepper"

interface ICICheckRunActionsJobStepListItemProps {
  readonly step: IAPIWorkflowJobStep
  readonly firstFailedStep: IAPIWorkflowJobStep | undefined

  /** Callback to open a job steps link on dotcom*/
  readonly onViewJobStepExternally: (step: IAPIWorkflowJobStep) => void
}

export class CICheckRunActionsJobStepListItem extends React.PureComponent<ICICheckRunActionsJobStepListItemProps> {
  private onViewJobStepExternally = () => {
    this.props.onViewJobStepExternally(this.props.step)
  }

  private onStepHeaderRef = (step: IAPIWorkflowJobStep) => {
    return (stepHeaderRef: HTMLDivElement | null) => {
      if (step.number === this.props.firstFailedStep?.number && stepHeaderRef !== null) {
        stepHeaderRef.scrollIntoView({ behavior: "smooth", block: "start" })
      }
    }
  }

  public render() {
    const { step } = this.props
    return (
      <div
        role="listitem"
        className="ci-check-run-job-step flex min-w-0 items-center gap-3 py-1"
        ref={this.onStepHeaderRef(step)}
        aria-label={`${step.name}, ${getFormattedCheckRunLongDuration(step)}, ${getClassNameForCheck(step)}`}>
        <StepperIndicator className="job-step-status-symbol shrink-0">
          <Octicon
            className={classNames("ci-status", `ci-status-${getClassNameForCheck(step)}`)}
            symbol={getSymbolForLogStep(step)}
          />
        </StepperIndicator>

        <TooltippedContent
          className="job-step-name min-w-0 flex-1 truncate"
          tooltip={step.name}
          onlyWhenOverflowed={true}
          tagName="span"
          direction={TooltipDirection.NORTH}>
          {step.name}
        </TooltippedContent>

        <div className="job-step-duration text-muted-foreground shrink-0 text-xs">
          {getFormattedCheckRunDuration(step)}
        </div>
        <Button
          role="link"
          variant="ghost"
          size="icon-sm"
          className="view-check-externally"
          onClick={this.onViewJobStepExternally}
          tooltip={i18n.t("desktopUI.viewStep", { name: step.name })}
          ariaLabel={i18n.t("desktopUI.viewStep", { name: step.name })}>
          <Octicon symbol={octicons.linkExternal} />
        </Button>
      </div>
    )
  }
}
