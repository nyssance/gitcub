// Desktop MIT port of ui/multi-commit-operation/dialog/warn-force-push-dialog.tsx; written as a function component.
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Checkbox, CheckboxValue } from "../desktop/checkbox"
import { Dialog, DialogContent, DialogFooter, OkCancelButtonGroup } from "../desktop/dialog"

interface IWarnForcePushProps {
  /** Desktop 传 MultiCommitOperationKind 或 'Amend'；这里是已翻译的操作名 */
  readonly operation: string
  readonly askForConfirmationOnForcePush: boolean
  /** Desktop onBegin 里的 dispatcher.setConfirmForcePushSetting 与 onBegin 合在一起 */
  readonly onBegin: (askForConfirmationOnForcePush: boolean) => void
  readonly onDismissed: () => void
}

export function WarnForcePushDialog({
  operation,
  askForConfirmationOnForcePush: initial,
  onBegin,
  onDismissed
}: IWarnForcePushProps) {
  const { t } = useTranslation()
  const [askForConfirmationOnForcePush, setAskForConfirmationOnForcePush] = useState(initial)

  return (
    <Dialog
      id="warn-force-push"
      title={t("warnForcePush.operationWillRequireForcePush", { operation })}
      onDismissed={onDismissed}
      onSubmit={() => onBegin(askForConfirmationOnForcePush)}
      backdropDismissable={false}
      type="warning"
      role="alertdialog"
      ariaDescribedBy="warn-force-push-confirmation-title warn-force-push-confirmation-message">
      <DialogContent>
        <p id="warn-force-push-confirmation-title">
          {t("warnForcePush.areYouSureYouWantToOperation", { operation: operation.toLowerCase() })}
        </p>
        <p id="warn-force-push-confirmation-message">
          {t("warnForcePush.atTheEndOfTheOperationFlow", { operation: operation.toLowerCase() })}
        </p>
        <div>
          <Checkbox
            label={t("warnForcePush.doNotShowThisMessageAgain")}
            value={askForConfirmationOnForcePush ? CheckboxValue.Off : CheckboxValue.On}
            onChange={checked => setAskForConfirmationOnForcePush(!checked)}
          />
        </div>
      </DialogContent>
      <DialogFooter>
        <OkCancelButtonGroup
          okButtonText={t("warnForcePush.beginOperation", { operation })}
          onCancelButtonClick={onDismissed}
        />
      </DialogFooter>
    </Dialog>
  )
}
