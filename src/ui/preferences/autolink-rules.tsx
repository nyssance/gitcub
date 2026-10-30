import { PlusIcon, TrashIcon } from "@primer/octicons-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"

import { type AutolinkRuleErrors, validateAutolinkRule } from "@/lib/autolink-rules"
import type { AutolinkRule } from "@/models/app-state"
import { Button } from "@/ui/base/button"
import { Checkbox } from "@/ui/base/checkbox"
import { Input } from "@/ui/base/input"

const emptyRule: AutolinkRule = { prefix: "", url: "", alphanumeric: false, ignoreCase: false, title: "" }

/** 设置 › 高级里的自动链接规则列表。
 *
 * 每条两行：前缀 + URL，标题 + 两个开关。每次改动都把通过校验的规则交给 onChange，
 * 没填完的条目留在列表里并标出错误，不写进状态。 */
export function AutolinkRules({
  rules,
  onChange
}: {
  rules: ReadonlyArray<AutolinkRule>
  onChange: (rules: AutolinkRule[]) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<AutolinkRule[]>(() => rules.map(rule => ({ ...rule })))
  const hintId = useId()

  const update = (next: AutolinkRule[]) => {
    setDraft(next)
    onChange(next.filter(rule => validateAutolinkRule(rule) === null))
  }
  const edit = (index: number, patch: Partial<AutolinkRule>) =>
    update(draft.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))

  const message = (errors: AutolinkRuleErrors | null) => {
    if (!errors) return null
    if (errors.prefix) return t("prefs.autolinkPrefixRequired")
    if (errors.url === "required") return t("prefs.autolinkUrlRequired")
    return t("prefs.autolinkUrlNum")
  }

  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm">{t("prefs.autolinks")}</div>
          <div id={hintId} className="text-muted-foreground text-xs">
            {t("prefs.autolinksHint")}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => update([...draft, { ...emptyRule }])}
          aria-describedby={hintId}>
          <PlusIcon data-icon="inline-start" size={16} />
          {t("prefs.autolinkAdd")}
        </Button>
      </div>
      {draft.length === 0 ? (
        <p className="text-muted-foreground py-2 text-xs">{t("prefs.autolinkNone")}</p>
      ) : (
        <ul className="mt-2 divide-y" aria-label={t("prefs.autolinks")}>
          {draft.map((rule, index) => {
            const errors = validateAutolinkRule(rule)
            const error = message(errors)
            const errorId = `${hintId}-${index}`
            const alphanumericId = `${hintId}-${index}-alphanumeric`
            const ignoreCaseId = `${hintId}-${index}-ignore-case`
            return (
              <li key={index} className="flex flex-col gap-1 py-2 text-xs">
                <div className="flex items-center gap-1">
                  <Input
                    value={rule.prefix}
                    placeholder="JIRA-"
                    aria-label={t("prefs.autolinkPrefix")}
                    aria-invalid={errors?.prefix ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    className="h-7 w-28 shrink-0 text-xs"
                    onChange={event => edit(index, { prefix: event.currentTarget.value })}
                  />
                  <Input
                    value={rule.url}
                    placeholder="https://jira.example.com/browse/JIRA-<num>"
                    aria-label={t("prefs.autolinkUrl")}
                    aria-invalid={errors?.url ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    className="h-7 min-w-0 flex-1 text-xs"
                    onChange={event => edit(index, { url: event.currentTarget.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("prefs.autolinkRemove")}
                    className="shrink-0"
                    onClick={() => update(draft.filter((_, i) => i !== index))}>
                    <TrashIcon size={14} />
                  </Button>
                </div>
                {error && (
                  <p id={errorId} role="alert" className="text-destructive text-xs">
                    {error}
                  </p>
                )}
                <div className="flex items-center gap-3">
                  <Input
                    value={rule.title ?? ""}
                    placeholder="Issue <num>"
                    aria-label={t("prefs.autolinkTitle")}
                    className="h-7 w-48 text-xs"
                    onChange={event => edit(index, { title: event.currentTarget.value })}
                  />
                  <label htmlFor={alphanumericId} className="flex items-center gap-1.5">
                    <Checkbox
                      id={alphanumericId}
                      checked={rule.alphanumeric}
                      onCheckedChange={checked => edit(index, { alphanumeric: checked })}
                    />
                    {t("prefs.autolinkAlphanumeric")}
                  </label>
                  <label htmlFor={ignoreCaseId} className="flex items-center gap-1.5">
                    <Checkbox
                      id={ignoreCaseId}
                      checked={rule.ignoreCase}
                      onCheckedChange={checked => edit(index, { ignoreCase: checked })}
                    />
                    {t("prefs.autolinkIgnoreCase")}
                  </label>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
