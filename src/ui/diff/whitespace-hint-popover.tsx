import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { PopoverDescription, PopoverHeader, PopoverTitle } from "@/components/ui/popover"

import { Popover, type PopoverAnchorPosition } from "../desktop/popover"

interface Props {
  readonly anchor: HTMLElement | null
  readonly anchorPosition: PopoverAnchorPosition
  readonly onHideWhitespaceInDiffChanged: (checked: boolean) => void
  readonly onDismissed: () => void
}

/** Desktop's whitespace-selection guard, anchored to the diff line it was raised from. */
export function WhitespaceHintPopover({ anchor, anchorPosition, onHideWhitespaceInDiffChanged, onDismissed }: Props) {
  const { t } = useTranslation()
  return (
    <Popover anchor={anchor} anchorPosition={anchorPosition} onClickOutside={onDismissed}>
        <PopoverHeader>
          <PopoverTitle>{t("diff.whitespaceTitle")}</PopoverTitle>
          <PopoverDescription>{t("diff.whitespaceBody")}</PopoverDescription>
        </PopoverHeader>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onDismissed}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              onHideWhitespaceInDiffChanged(false)
              onDismissed()
            }}>
            {t("diff.showWhitespace")}
          </Button>
        </div>
    </Popover>
  )
}
