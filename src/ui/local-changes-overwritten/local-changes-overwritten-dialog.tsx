// Desktop MIT port of ui/local-changes-overwritten/local-changes-overwritten-dialog.tsx; written as a function component.
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { type RetryAction, RetryActionType } from "../../models/retry-actions"
import { assertNever } from "../../upstream/lib/fatal-error"
import { DefaultDialogFooter, Dialog, DialogContent, DialogFooter, OkCancelButtonGroup } from "../desktop/dialog"
import { PathText } from "../desktop/path-text"

interface ILocalChangesOverwrittenDialogProps {
  /**
   * Whether there's already a stash entry for the local branch.
   */
  readonly hasExistingStash: boolean
  /**
   * The action that should get executed if the user selects "Stash and Continue".
   */
  readonly retryAction: RetryAction
  /**
   * Callback to use when the dialog gets closed.
   */
  readonly onDismissed: () => void
  /**
   * The files that prevented the operation from completing, i.e. the files
   * that would be overwritten.
   */
  readonly files: ReadonlyArray<string>
  /** Desktop dispatcher.createStashForCurrentBranch(repository, false) */
  readonly onCreateStash: () => Promise<boolean>
  /** Desktop dispatcher.performRetry */
  readonly onRetry: (retryAction: RetryAction) => void
}

export function LocalChangesOverwrittenDialog(props: ILocalChangesOverwrittenDialogProps) {
  const { t } = useTranslation()
  const [stashing, setStashing] = useState(false)
  const { files, hasExistingStash, retryAction } = props

  const canStashChanges = !hasExistingStash && !stashing && retryAction.type !== RetryActionType.PopStash

  const onSubmit = async () => {
    if (hasExistingStash) {
      props.onDismissed()
      return
    }

    setStashing(true)

    const createdStash = await props.onCreateStash()

    props.onDismissed()

    if (createdStash) {
      props.onRetry(retryAction)
    }
  }

  return (
    <Dialog
      title={t("localChangesOverwritten.error")}
      id="local-changes-overwritten"
      loading={stashing}
      disabled={stashing}
      onDismissed={props.onDismissed}
      onSubmit={onSubmit}
      type="error"
      role="alertdialog"
      ariaDescribedBy="local-changes-error-description">
      <DialogContent>
        <div id="local-changes-error-description">
          <p>
            {t("localChangesOverwritten.unableToActionWhenChangesArePresentOnYourBranch", {
              action: retryActionName(retryAction, t)
            })}
            {files.length > 0 ? t("localChangesOverwritten.theFollowingFilesWouldBeOverwritten") : null}
          </p>
          {files.length > 0 && (
            <div className="files-list">
              <ul>
                {files.map(fileName => (
                  <li key={fileName}>
                    <PathText path={fileName} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canStashChanges && <p>{t("localChangesOverwritten.youCanStashYourChangesNowAndRecoverThemAfterwards")}</p>}
        </div>
      </DialogContent>
      {canStashChanges ? (
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={t("localChangesOverwritten.stashChangesAndContinue")}
            okButtonTitle={t("localChangesOverwritten.thisWillCreateAStashWithYourCurrentChanges")}
            cancelButtonText={t("localChangesOverwritten.close")}
          />
        </DialogFooter>
      ) : (
        <DefaultDialogFooter buttonText={t("localChangesOverwritten.close")} />
      )}
    </Dialog>
  )
}

function retryActionName(retryAction: RetryAction, t: (key: string) => string) {
  switch (retryAction.type) {
    case RetryActionType.Checkout:
      return t("localChangesOverwritten.checkout")
    case RetryActionType.Pull:
      return t("localChangesOverwritten.pull")
    case RetryActionType.Merge:
      return t("localChangesOverwritten.merge")
    case RetryActionType.Rebase:
      return t("localChangesOverwritten.rebase")
    case RetryActionType.Clone:
      return t("localChangesOverwritten.clone")
    case RetryActionType.Fetch:
      return t("localChangesOverwritten.fetch")
    case RetryActionType.Push:
      return t("localChangesOverwritten.push")
    case RetryActionType.CherryPick:
    case RetryActionType.CreateBranchForCherryPick:
      return t("localChangesOverwritten.cherryPick")
    case RetryActionType.Squash:
      return t("localChangesOverwritten.squash")
    case RetryActionType.Reorder:
      return t("localChangesOverwritten.reorder")
    case RetryActionType.DiscardChanges:
      return t("localChangesOverwritten.discardChanges")
    case RetryActionType.PopStash:
      return t("localChangesOverwritten.restoreStashedChanges")
    default:
      return assertNever(retryAction, `Unknown retryAction: ${retryAction}`)
  }
}
