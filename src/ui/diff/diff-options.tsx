import { GearIcon, TriangleDownIcon } from "@primer/octicons-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/ui/base/button"
import { Checkbox } from "@/ui/base/checkbox"
import { Label } from "@/ui/base/label"
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/ui/base/popover"
import { RadioGroup, RadioGroupItem } from "@/ui/base/radio-group"

/** Desktop `diff-options.tsx`：齿轮按钮弹出 Diff Settings，含「隐藏空白改动」与「统一 / 并排」。
 *  另加本项目已有的「自动换行」，放在同一个弹层里，不再占顶栏。 */
export function DiffOptions(props: {
  isInteractiveDiff: boolean
  hideWhitespaceChanges: boolean
  onHideWhitespaceChangesChanged: (value: boolean) => void
  showSideBySideDiff: boolean
  onShowSideBySideDiffChanged: (value: boolean) => void
  wrap: boolean
  onWrapChanged: (value: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="diff-options-component shrink-0 gap-0.5 px-1.5"
            aria-label={t("diff.settings")}
            title={t("diff.settings")}
          />
        }>
        <GearIcon size={16} />
        <TriangleDownIcon size={16} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-4 text-xs">
        <PopoverHeader>
          <PopoverTitle className="text-sm">{t("diff.settings")}</PopoverTitle>
        </PopoverHeader>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-semibold">{t("diff.whitespace")}</legend>
          <Label className="text-xs font-normal">
            <Checkbox
              checked={props.hideWhitespaceChanges}
              onCheckedChange={value => props.onHideWhitespaceChangesChanged(value)}
            />
            {t("diff.hideWhitespace")}
          </Label>
          {props.isInteractiveDiff && <p className="text-muted-foreground">{t("diff.hideWhitespaceHint")}</p>}
        </fieldset>
        <fieldset>
          <legend className="mb-2 font-semibold">{t("diff.display")}</legend>
          <RadioGroup
            value={props.showSideBySideDiff ? "split" : "unified"}
            onValueChange={value => props.onShowSideBySideDiffChanged(value === "split")}
            className="gap-2">
            <Label className="text-xs font-normal">
              <RadioGroupItem value="unified" />
              {t("diff.unified")}
            </Label>
            <Label className="text-xs font-normal">
              <RadioGroupItem value="split" />
              {t("diff.split")}
            </Label>
          </RadioGroup>
        </fieldset>
        <fieldset>
          <legend className="mb-2 font-semibold">{t("diff.lines")}</legend>
          <Label className="text-xs font-normal">
            <Checkbox checked={props.wrap} onCheckedChange={value => props.onWrapChanged(value)} />
            {t("diff.wrap")}
          </Label>
        </fieldset>
      </PopoverContent>
    </Popover>
  )
}
