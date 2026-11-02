// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import i18n from "../../lib/i18n"
import { startTimer } from "../../lib/ui/timing"
import type { Branch } from "../../models/branch"
import { type Popup, PopupType } from "../../models/popup"
import type { Repository } from "../../models/repository"
import { UncommittedChangesStrategy } from "../../upstream/models/uncommitted-changes-strategy"
import { Dialog, DialogContent, DialogFooter } from "../desktop/dialog"
import { OkCancelButtonGroup } from "../desktop/dialog/ok-cancel-button-group"
import { Row } from "../desktop/row"
import { VerticalSegmentedControl } from "../desktop/vertical-segmented-control/vertical-segmented-control"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"

interface Dispatcher {
  showPopup(popup: Popup): void
  checkoutBranch(repository: Repository, branch: Branch, strategy?: UncommittedChangesStrategy): Promise<Repository>
}

enum StashAction {
  StashOnCurrentBranch,
  MoveToNewBranch
}

interface ISwitchBranchProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly currentBranch: Branch

  /** The branch to checkout after the user selects a stash action */
  readonly branchToCheckout: Branch

  /** Whether `currentBranch` has an existing stash association */
  readonly hasAssociatedStash: boolean
  readonly onDismissed: () => void
}

interface ISwitchBranchState {
  readonly isStashingChanges: boolean
  readonly selectedStashAction: StashAction
  readonly currentBranchName: string
}

/**
 * Dialog that alerts users that their changes may be lost and offers them the
 * chance to stash them or potentially take them to another branch
 */
export class StashAndSwitchBranch extends React.Component<ISwitchBranchProps, ISwitchBranchState> {
  public constructor(props: ISwitchBranchProps) {
    super(props)

    this.state = {
      isStashingChanges: false,
      selectedStashAction: StashAction.StashOnCurrentBranch,
      currentBranchName: props.currentBranch.name
    }
  }

  public render() {
    const { isStashingChanges } = this.state
    return (
      <Dialog
        id="stash-changes"
        title={i18n.t("desktopUI.switchBranch")}
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        loading={isStashingChanges}
        disabled={isStashingChanges}>
        <DialogContent>
          {this.renderStashActions()}
          {this.renderStashOverwriteWarning()}
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup okButtonText={i18n.t("desktopUI.switchBranch")} okButtonDisabled={isStashingChanges} />
        </DialogFooter>
      </Dialog>
    )
  }

  private renderStashOverwriteWarning() {
    if (!this.props.hasAssociatedStash || this.state.selectedStashAction !== StashAction.StashOnCurrentBranch) {
      return null
    }

    return (
      <Row>
        <Octicon symbol={octicons.alert} /> {i18n.t("desktopUI.stashOverwriteWarning")}
      </Row>
    )
  }

  private renderStashActions() {
    const { branchToCheckout } = this.props
    const items = [
      {
        title: i18n.t("desktopUI.leaveChanges", { branch: this.state.currentBranchName }),
        description: i18n.t("desktopUI.leaveChangesDescription"),
        key: StashAction.StashOnCurrentBranch
      },
      {
        title: i18n.t("desktopUI.bringChanges", { branch: branchToCheckout.name }),
        description: i18n.t("desktopUI.bringChangesDescription"),
        key: StashAction.MoveToNewBranch
      }
    ]

    return (
      <Row>
        <VerticalSegmentedControl
          label={i18n.t("desktopUI.stashActionQuestion")}
          items={items}
          selectedKey={this.state.selectedStashAction}
          onSelectionChanged={this.onSelectionChanged}
        />
      </Row>
    )
  }

  private onSelectionChanged = (action: StashAction) => {
    this.setState({ selectedStashAction: action })
  }

  private onSubmit = async () => {
    const { repository, branchToCheckout, dispatcher, hasAssociatedStash } = this.props
    const { selectedStashAction } = this.state

    if (selectedStashAction === StashAction.StashOnCurrentBranch && hasAssociatedStash) {
      dispatcher.showPopup({
        type: PopupType.ConfirmOverwriteStash,
        repository,
        branchToCheckout
      })
      return
    }

    this.setState({ isStashingChanges: true })

    const timer = startTimer("stash and checkout", repository)
    try {
      if (selectedStashAction === StashAction.StashOnCurrentBranch) {
        await dispatcher.checkoutBranch(repository, branchToCheckout, UncommittedChangesStrategy.StashOnCurrentBranch)
      } else if (selectedStashAction === StashAction.MoveToNewBranch) {
        // attempt to checkout the branch without creating a stash entry
        await dispatcher.checkoutBranch(repository, branchToCheckout, UncommittedChangesStrategy.MoveToNewBranch)
      }
    } finally {
      timer.done()
      this.setState({ isStashingChanges: false }, () => {
        this.props.onDismissed()
      })
    }
  }
}
