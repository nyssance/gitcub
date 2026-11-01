// Desktop MIT port of ui/delete-tag/delete-tag-dialog.tsx; written as a function component.
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Dialog, DialogContent, DialogFooter, OkCancelButtonGroup } from "../desktop/dialog"
import { Ref } from "../desktop/ref"

interface IDeleteTagProps {
  readonly tagName: string
  /** Desktop dispatcher.deleteTag(repository, tagName) */
  readonly onDeleteTag: (tagName: string) => Promise<void>
  readonly onDismissed: () => void
}

export function DeleteTag({ tagName, onDeleteTag, onDismissed }: IDeleteTagProps) {
  const { t } = useTranslation()
  const [isDeleting, setIsDeleting] = useState(false)

  const deleteTag = async () => {
    setIsDeleting(true)

    await onDeleteTag(tagName)
    onDismissed()
  }

  return (
    <Dialog
      id="delete-tag"
      title={t("deleteTag.deleteTag")}
      type="warning"
      onSubmit={deleteTag}
      onDismissed={onDismissed}
      disabled={isDeleting}
      loading={isDeleting}
      role="alertdialog"
      ariaDescribedBy="delete-tag-confirmation">
      <DialogContent>
        <p id="delete-tag-confirmation">
          {t("deleteTag.areYouSureYouWantToDeleteTheTag")} <Ref>{tagName}</Ref>?
        </p>
      </DialogContent>
      <DialogFooter>
        <OkCancelButtonGroup destructive={true} okButtonText={t("deleteTag.delete")} />
      </DialogFooter>
    </Dialog>
  )
}
