// Desktop MIT port of ui/checkout/confirm-checkout-commit.tsx; written as a function component.
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Checkbox, CheckboxValue } from "../desktop/checkbox"
import { Dialog, DialogContent, DialogFooter, OkCancelButtonGroup } from "../desktop/dialog"
import { Row } from "../desktop/row"

interface IConfirmCheckoutCommitProps {
  readonly askForConfirmationOnCheckoutCommit: boolean
  /** Desktop onSubmit 里的 dispatcher.setConfirmCheckoutCommitSetting 与 dispatcher.checkoutCommit */
  readonly onCheckoutCommit: (askForConfirmationOnCheckoutCommit: boolean) => Promise<void>
  readonly onDismissed: () => void
}

/**
 * Dialog to confirm checking out a commit
 */
export function ConfirmCheckoutCommitDialog({
  askForConfirmationOnCheckoutCommit,
  onCheckoutCommit,
  onDismissed
}: IConfirmCheckoutCommitProps) {
  const { t } = useTranslation()
  const [isCheckingOut, setIsCheckingOut] = useState(false)
  const [confirmCheckoutCommit, setConfirmCheckoutCommit] = useState(askForConfirmationOnCheckoutCommit)

  const onSubmit = async () => {
    setIsCheckingOut(true)
    try {
      await onCheckoutCommit(confirmCheckoutCommit)
    } finally {
      setIsCheckingOut(false)
    }
    onDismissed()
  }

  return (
    <Dialog
      id="checkout-commit"
      type="warning"
      title={t("confirmCheckoutCommit.checkoutCommit")}
      loading={isCheckingOut}
      disabled={isCheckingOut}
      onSubmit={onSubmit}
      onDismissed={onDismissed}
      ariaDescribedBy="checking-out-commit-confirmation"
      role="alertdialog">
      <DialogContent>
        <Row id="checking-out-commit-confirmation">{t("confirmCheckoutCommit.checkingOutACommitWillCreateADetachedHead")}</Row>
        <Row>
          <Checkbox
            label={t("confirmCheckoutCommit.doNotShowThisMessageAgain")}
            value={confirmCheckoutCommit ? CheckboxValue.Off : CheckboxValue.On}
            onChange={checked => setConfirmCheckoutCommit(!checked)}
          />
        </Row>
      </DialogContent>
      <DialogFooter>
        <OkCancelButtonGroup destructive={true} okButtonText={t("confirmCheckoutCommit.checkout")} />
      </DialogFooter>
    </Dialog>
  )
}
