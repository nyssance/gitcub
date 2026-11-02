// Desktop MIT port of ui/app-error.tsx; written as a function component. The Copilot error branch is left out
// (Copilot was removed from this product on 2026-10-21).
import * as React from "react"
import { useTranslation } from "react-i18next"

import { coerceToString } from "../lib/coerce-to-string"
import { DugiteError } from "../lib/dugite-errors"
import { isAuthFailureError } from "../lib/git-error-description"
import { getFileFromExceedsError } from "../lib/helpers/regex"
import { type RetryAction, RetryActionType } from "../models/retry-actions"
import { Spinner } from "@/components/ui/spinner"
import { getUnderlyingError, isErrorWithMetaData, isGitError, isRawGitError } from "./desktop-error"
import { DefaultDialogFooter, Dialog, DialogContent, DialogFooter, OkCancelButtonGroup } from "./desktop/dialog"
import { LinkButton } from "./desktop/link-button"
import { Ref } from "./desktop/ref"

const Terminal = React.lazy(() => import("./terminal").then(module => ({ default: module.Terminal })))

/** Desktop app.tsx dialogTransitionTimeout.exit */
const dialogTransitionExitTimeout = 100

interface IAppErrorProps {
  /** The error to be displayed  */
  readonly error: Error

  /** Called to dismiss the dialog */
  readonly onDismissed: () => void
  /** Desktop onShowPopup({ type: PopupType.Preferences }) */
  readonly onShowPreferences: () => void
  readonly onRetryAction: (retryAction: RetryAction) => void
}

/**
 * A component which renders application-wide errors as dialogs. Only one error
 * is shown per dialog and if multiple errors are queued up they will be shown
 * in the order they were queued.
 */
export function AppError({ error, onDismissed, onShowPreferences, onRetryAction: retry }: IAppErrorProps) {
  const { t } = useTranslation()
  const dialogContent = React.useRef<HTMLDivElement | null>(null)

  const showPreferencesDialog = () => {
    onDismissed()

    window.setTimeout(onShowPreferences, dialogTransitionExitTimeout)
  }

  const onRetryAction = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    onDismissed()

    if (isErrorWithMetaData(error)) {
      const { retryAction } = error.metadata
      if (retryAction !== undefined) {
        retry(retryAction)
      }
    }
  }

  const renderErrorMessage = (error: Error) => {
    const e = getUnderlyingError(error)

    if (isRawGitError(e)) {
      return (
        <React.Suspense fallback={<Spinner />}>
          <Terminal terminalOutput={e.message} rows={15} cols={80} />
        </React.Suspense>
      )
    }

    if (isGitError(e) && e.result.gitError === DugiteError.PushWithFileSizeExceedingLimit) {
      const files = getFileFromExceedsError(coerceToString(e.result.stderr))
      return (
        <>
          <p>{error.message}</p>
          {files.length > 0 && (
            <>
              <p>{t("appError.filesThatExceedTheLimit")}</p>
              <ul>
                {files.map(file => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </>
          )}
          <p>
            {t("appError.see")} <LinkButton uri="https://gh.io/lfs">https://gh.io/lfs</LinkButton>{" "}
            {t("appError.forMoreInformationOnManagingLargeFilesOnGitHub")}
          </p>
        </>
      )
    }

    return <p>{e.message}</p>
  }

  const getTitle = (error: Error) => {
    switch (getDugiteError(error)) {
      case DugiteError.PushWithFileSizeExceedingLimit:
        return t("appError.fileSizeLimitExceeded")
    }

    switch (getRetryActionType(error)) {
      case RetryActionType.Clone:
        return t("appError.cloneFailed")
      case RetryActionType.Push:
        return t("appError.failedToPush")
    }

    if (isErrorWithMetaData(error)) {
      const { gitContext } = error.metadata
      switch (gitContext?.kind) {
        case "create-repository":
          return t("appError.failedCreatingRepository")
        case "commit":
          return t("appError.commitFailed")
      }
    }

    return t("appError.error")
  }

  const renderContentAfterErrorMessage = (error: Error) => {
    if (!isErrorWithMetaData(error)) {
      return undefined
    }

    const { retryAction } = error.metadata

    if (retryAction?.type === RetryActionType.Clone) {
      return (
        <p>
          {t("appError.wouldYouLikeToRetryCloning")} <Ref>{retryAction.name}</Ref>?
        </p>
      )
    }

    return undefined
  }

  // Desktop scrollToBottomOfGitErrorMessage：原始输出滚到最后，看得到 git 最后说了什么
  React.useEffect(() => {
    if (dialogContent.current !== null && isRawGitError(getUnderlyingError(error))) {
      dialogContent.current.scrollTop = dialogContent.current.scrollHeight
    }
  }, [error])

  const onCloseButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    onDismissed()
  }

  const renderFooter = (error: Error) => {
    if (isCloneError(error)) {
      return (
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={t("appError.retryClone")}
            onOkButtonClick={onRetryAction}
            onCancelButtonClick={onCloseButtonClick}
          />
        </DialogFooter>
      )
    }

    const underlyingError = getUnderlyingError(error)

    if (isGitError(underlyingError)) {
      const { gitError } = underlyingError.result
      if (gitError && isAuthFailureError(gitError as DugiteError)) {
        return (
          <DialogFooter>
            <OkCancelButtonGroup
              okButtonText={t("appError.close")}
              onOkButtonClick={onCloseButtonClick}
              cancelButtonText={t("appError.openPreferences")}
              onCancelButtonClick={showPreferencesDialog}
            />
          </DialogFooter>
        )
      }
    }

    return <DefaultDialogFooter buttonText={t("appError.close")} onButtonClick={onCloseButtonClick} />
  }

  return (
    <Dialog
      id="app-error"
      type="error"
      key="error"
      title={getTitle(error)}
      backdropDismissable={false}
      onSubmit={onDismissed}
      onDismissed={onDismissed}
      className={isRawGitError(error) ? "raw-git-error sm:max-w-[750px]" : undefined}
      role="alertdialog"
      ariaDescribedBy="app-error-description">
      <DialogContent
        onRef={ref => {
          dialogContent.current = ref
        }}>
        <div id="app-error-description">
          {renderErrorMessage(error)}
          {renderContentAfterErrorMessage(error)}
        </div>
      </DialogContent>
      {renderFooter(error)}
    </Dialog>
  )
}

function isCloneError(error: Error) {
  if (!isErrorWithMetaData(error)) {
    return false
  }
  const { retryAction } = error.metadata
  return retryAction?.type === RetryActionType.Clone
}

function getRetryActionType(error: Error) {
  if (!isErrorWithMetaData(error)) {
    return undefined
  }

  return error.metadata.retryAction?.type
}

function getDugiteError(error: Error) {
  const e = getUnderlyingError(error)
  return isGitError(e) ? e.result.gitError : undefined
}
