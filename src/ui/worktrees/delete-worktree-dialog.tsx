// Desktop MIT port; platform imports adapted to Tauri.

import * as React from "react"

import i18n from "../../lib/i18n"
import * as Path from "../../lib/platform-path"
import type { Repository } from "../../models/repository"
import type { IDeleteWorktreeOptions } from "../../models/worktree"
import { Checkbox, CheckboxValue } from "../desktop/checkbox"
import { Dialog, DialogContent, DialogFooter } from "../desktop/dialog"
import { OkCancelButtonGroup } from "../desktop/dialog/ok-cancel-button-group"

interface IDeleteWorktreeDialogProps {
  readonly repository: Repository
  readonly worktreePath: string
  readonly options: IDeleteWorktreeOptions
  readonly askForConfirmationOnWorktreeRemoval: boolean
  readonly onDeleteWorktree: (
    repository: Repository,
    worktreePath: string,
    options?: IDeleteWorktreeOptions
  ) => Promise<void>
  readonly onConfirmWorktreeRemovalChanged: (value: boolean) => void
  readonly onDismissed: () => void
}

interface IDeleteWorktreeDialogState {
  readonly isDeleting: boolean
  readonly confirmWorktreeRemoval: boolean
}

export class DeleteWorktreeDialog extends React.Component<IDeleteWorktreeDialogProps, IDeleteWorktreeDialogState> {
  public constructor(props: IDeleteWorktreeDialogProps) {
    super(props)

    this.state = {
      isDeleting: false,
      confirmWorktreeRemoval: props.askForConfirmationOnWorktreeRemoval
    }
  }

  public render() {
    const isMissing = this.props.options.isMissing === true
    const name = Path.basename(this.props.worktreePath)

    const title = i18n.t(isMissing ? "desktopUI.removeMissingWorktree" : "desktopUI.deleteWorktree")

    return (
      <Dialog
        id="delete-worktree"
        title={title}
        type="warning"
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        disabled={this.state.isDeleting}
        loading={this.state.isDeleting}
        role="alertdialog"
        ariaDescribedBy="delete-worktree-confirmation">
        <DialogContent>
          <p id="delete-worktree-confirmation">
            {i18n.t(isMissing ? "desktopUI.missingWorktreeConfirm" : "desktopUI.deleteWorktreeConfirm", { name })}
          </p>
          {!isMissing && (
            <Checkbox
              label={i18n.t("desktopUI.dontAskAgain")}
              value={this.state.confirmWorktreeRemoval ? CheckboxValue.Off : CheckboxValue.On}
              onChange={this.onConfirmWorktreeRemovalChanged}
            />
          )}
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            destructive={true}
            okButtonText={i18n.t(isMissing ? "desktopUI.remove" : "desktopUI.delete")}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private onConfirmWorktreeRemovalChanged = (checked: boolean) => {
    const value = !checked
    this.setState({ confirmWorktreeRemoval: value })
  }

  private onSubmit = async () => {
    this.setState({ isDeleting: true })

    this.props.onConfirmWorktreeRemovalChanged(this.state.confirmWorktreeRemoval)

    await this.props.onDeleteWorktree(this.props.repository, this.props.worktreePath, this.props.options)
    this.props.onDismissed()
  }
}
