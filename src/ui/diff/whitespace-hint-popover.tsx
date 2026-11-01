import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle } from "@/components/ui/popover"
import type { PopoverAnchorPosition } from "../desktop/popover"

interface Props {
  readonly anchor: HTMLElement | null
  readonly anchorPosition: PopoverAnchorPosition
  readonly onHideWhitespaceInDiffChanged: (checked: boolean) => void
  readonly onDismissed: () => void
}

/** Desktop's whitespace-selection guard, presented with the standard shadcn popover. */
export function WhitespaceHintPopover({ anchor, onHideWhitespaceInDiffChanged, onDismissed }: Props) {
  const { t } = useTranslation()
  return (
    <Popover
      open
      onOpenChange={open => {
        if (!open) onDismissed()
      }}>
      <PopoverContent anchor={anchor} side="right" finalFocus={() => anchor}>
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
      </PopoverContent>
    </Popover>
  )
}
