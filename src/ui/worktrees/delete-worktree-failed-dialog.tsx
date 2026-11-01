// Desktop MIT port; platform imports adapted to Tauri.

import { platform } from "@tauri-apps/plugin-os"
import * as React from "react"

import * as Path from "../../lib/platform-path"
import type { Repository } from "../../models/repository"
import type { IDeleteWorktreeOptions, WorktreeEntry } from "../../models/worktree"
import { Spinner } from "@/components/ui/spinner"
import { getUnderlyingError, isRawGitError } from "../desktop-error"
import { Dialog, DialogContent, DialogFooter } from "../desktop/dialog"
import { OkCancelButtonGroup } from "../desktop/dialog/ok-cancel-button-group"
import { Ref } from "../desktop/ref"

const Terminal = React.lazy(() => import("../terminal").then(module => ({ default: module.Terminal })))

interface IDeleteWorktreeFailedDialogProps {
  readonly repository: Repository
  readonly worktreePath: string
  readonly options: IDeleteWorktreeOptions
  readonly onDeleteWorktree: (
    repository: Repository,
    worktreePath: string,
    options?: IDeleteWorktreeOptions
  ) => Promise<void>
  readonly onSwitchToWorktree: (repository: Repository, worktree: WorktreeEntry) => Promise<void>
  readonly error: Error
  readonly originalWorktree: WorktreeEntry | null
  readonly onDismissed: () => void
}

interface IDeleteWorktreeFailedDialogState {
  readonly isDeleting: boolean
}

export class DeleteWorktreeFailedDialog extends React.Component<
  IDeleteWorktreeFailedDialogProps,
  IDeleteWorktreeFailedDialogState
> {
  public constructor(props: IDeleteWorktreeFailedDialogProps) {
    super(props)

    this.state = {
      isDeleting: false
    }
  }

  public render() {
    const name = Path.basename(this.props.worktreePath)

    return (
      <Dialog
        id="delete-worktree-failed"
        title={platform() === "macos" ? "Delete Worktree Failed" : "Delete worktree failed"}
        type="error"
        onSubmit={this.onSubmit}
        onDismissed={this.onDismissed}
        disabled={this.state.isDeleting}
        loading={this.state.isDeleting}
        role="alertdialog"
        ariaDescribedBy="delete-worktree-failed-message">
        <DialogContent>
          <div id="delete-worktree-failed-message">
            <p>
              Deleting the worktree <Ref>{name}</Ref> failed.
            </p>
            {this.renderErrorMessage()}
            <p>
              Would you like to forcefully delete the worktree <Ref>{name}</Ref>?
            </p>
          </div>
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup destructive={true} okButtonText="Forcefully delete" />
        </DialogFooter>
      </Dialog>
    )
  }

  private renderErrorMessage() {
    const e = getUnderlyingError(this.props.error)

    if (isRawGitError(e)) {
      return (
        <React.Suspense fallback={<Spinner />}>
          <Terminal terminalOutput={e.message} rows={8} cols={80} />
        </React.Suspense>
      )
    }

    return <p>{e.toString()}</p>
  }

  private onDismissed = () => {
    const { originalWorktree, repository } = this.props

    if (originalWorktree !== null) {
      this.props.onSwitchToWorktree(repository, originalWorktree)
    }

    this.props.onDismissed()
  }

  private onSubmit = async () => {
    this.setState({ isDeleting: true })
    await this.props.onDeleteWorktree(this.props.repository, this.props.worktreePath, {
      ...this.props.options,
      force: true
    })
    this.props.onDismissed()
  }
}
