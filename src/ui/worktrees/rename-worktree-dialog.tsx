// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import i18n from "../../lib/i18n"
import * as Path from "../../lib/platform-path"
import type { Repository } from "../../models/repository"
import { Dialog, DialogContent, DialogFooter } from "../desktop/dialog"
import { OkCancelButtonGroup } from "../desktop/dialog/ok-cancel-button-group"
import { TextBox } from "../desktop/text-box"

interface Dispatcher {
  moveWorktree(repository: Repository, worktreePath: string, newPath: string): Promise<boolean>
}

interface IRenameWorktreeDialogProps {
  readonly repository: Repository
  readonly worktreePath: string
  readonly dispatcher: Dispatcher
  readonly onDismissed: () => void
}

interface IRenameWorktreeDialogState {
  readonly newName: string
  readonly renaming: boolean
}

export class RenameWorktreeDialog extends React.Component<IRenameWorktreeDialogProps, IRenameWorktreeDialogState> {
  public constructor(props: IRenameWorktreeDialogProps) {
    super(props)

    this.state = {
      newName: Path.basename(props.worktreePath),
      renaming: false
    }
  }

  private onNameChanged = (newName: string) => {
    this.setState({ newName })
  }

  private onSubmit = async () => {
    const { worktreePath, repository, onDismissed } = this.props
    const { newName } = this.state
    const newPath = Path.join(Path.dirname(worktreePath), newName)

    this.setState({ renaming: true })

    const success = await this.props.dispatcher.moveWorktree(repository, worktreePath, newPath)

    this.setState({ renaming: false })

    if (success) {
      onDismissed()
    }
  }

  public render() {
    const currentName = Path.basename(this.props.worktreePath)
    const disabled = this.state.newName.length === 0 || this.state.newName === currentName || this.state.renaming

    return (
      <Dialog
        id="rename-worktree"
        title={i18n.t("desktopUI.renameWorktree")}
        loading={this.state.renaming}
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}>
        <DialogContent>
          <TextBox label={i18n.t("desktopUI.name")} value={this.state.newName} onValueChanged={this.onNameChanged} />
        </DialogContent>

        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={i18n.t("desktopUI.renameWorktreeAction", { name: currentName })}
            okButtonDisabled={disabled}
          />
        </DialogFooter>
      </Dialog>
    )
  }
}
