// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { orderedTutorialSteps, type ValidTutorialStep } from "../../upstream/models/tutorial-step"
import { Button } from "../base/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../base/collapsible"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"

interface ITutorialStepInstructionsProps {
  /** Text displayed to summarize this step */
  readonly summaryText: string
  /** Used to find out if this step has been completed */
  readonly isComplete: (step: ValidTutorialStep) => boolean
  /** The step for this section */
  readonly sectionId: ValidTutorialStep
  /** Used to find out if this is the next step for the user to complete */
  readonly isNextStepTodo: (step: ValidTutorialStep) => boolean

  /** ID of the currently expanded tutorial step
   * (used to determine if this step is expanded)
   */
  readonly currentlyOpenSectionId: ValidTutorialStep

  /** Skip button (if possible for this step) */
  readonly skipLinkButton?: React.JSX.Element
  /** Handler to open and close section */
  readonly onSummaryClick: (id: ValidTutorialStep) => void
}

/** A step (summary and expandable description) in the tutorial side panel */
export class TutorialStepInstructions extends React.Component<React.PropsWithChildren<ITutorialStepInstructionsProps>> {
  public render() {
    return (
      <li key={this.props.sectionId}>
        <Collapsible open={this.props.sectionId === this.props.currentlyOpenSectionId} onOpenChange={this.onOpenChange}>
          {this.renderSummary()}
          <CollapsibleContent>{this.props.children}</CollapsibleContent>
        </Collapsible>
      </li>
    )
  }

  private onOpenChange = (open: boolean) => {
    if (open) {
      this.props.onSummaryClick(this.props.sectionId)
    }
  }

  private renderSummary = () => {
    const shouldShowSkipLink =
      this.props.skipLinkButton !== undefined &&
      this.props.currentlyOpenSectionId === this.props.sectionId &&
      this.props.isNextStepTodo(this.props.sectionId)
    return (
      <div className="flex items-center gap-2">
        <CollapsibleTrigger render={<Button variant="ghost" className="min-w-0 flex-1 justify-start" />}>
          {this.renderTutorialStepIcon()}
          <span className="min-w-0 flex-1 truncate text-left">{this.props.summaryText}</span>
          <Octicon symbol={octicons.chevronDown} />
        </CollapsibleTrigger>
        {shouldShowSkipLink && this.props.skipLinkButton}
      </div>
    )
  }

  private renderTutorialStepIcon() {
    if (this.props.isComplete(this.props.sectionId)) {
      return (
        <div className="green-circle">
          <Octicon symbol={octicons.check} />
        </div>
      )
    }

    // ugh zero-indexing
    const stepNumber = orderedTutorialSteps.indexOf(this.props.sectionId) + 1
    return this.props.isNextStepTodo(this.props.sectionId) ? (
      <div className="blue-circle">{stepNumber}</div>
    ) : (
      <div className="empty-circle">{stepNumber}</div>
    )
  }
}
