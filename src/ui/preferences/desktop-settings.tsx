import { useTranslation } from "react-i18next"

import { type Prompt, tabSizeDefault, usePreferencesStore } from "@/features/preferences/store"
import { formatNumber } from "@/lib/format-number"
import {
  type DateFormat,
  dateFormats,
  numberFormatFromKey,
  numberFormats,
  numberFormatToKey,
  type TimeFormat,
  timeFormats
} from "@/models/formatting-preferences"
import { Checkbox } from "@/ui/base/checkbox"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/ui/base/field"
import { NativeSelect, NativeSelectOption } from "@/ui/base/native-select"
import { RadioGroup, RadioGroupItem } from "@/ui/base/radio-group"
import { UncommittedChangesStrategy } from "@/upstream/models/uncommitted-changes-strategy"

/** 一个带说明的勾选项：原版 Checkbox + settings-description */
function CheckboxField({
  id,
  label,
  description,
  checked,
  onChange
}: {
  id: string
  label: string
  description?: React.ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <Checkbox id={id} checked={checked} onCheckedChange={value => onChange(value)} />
      <FieldContent>
        <FieldLabel htmlFor={id} className="font-normal">
          {label}
        </FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
    </Field>
  )
}

/** 原版 Prompts 里本项目有对应行为的几项，顺序照原版。
 *  「永久丢弃」（移到废纸篓失败时）与「检出提交」本项目没有对应操作，不列。 */
const PROMPTS: [Prompt, string][] = [
  ["confirmRepoRemoval", "prefs.removingRepositories"],
  ["confirmDiscardChanges", "prefs.discardingChanges"],
  ["confirmDiscardStash", "prefs.discardingStash"],
  ["confirmForcePush", "prefs.forcePushing"],
  ["confirmUndoCommit", "prefs.undoCommit"],
  ["confirmWorktreeRemoval", "prefs.removingWorktrees"],
  ["confirmCommitFilteredChanges", "prefs.committingChangesHiddenByFilter"]
]

const STRATEGIES: [UncommittedChangesStrategy, string][] = [
  [UncommittedChangesStrategy.AskForConfirmation, "prefs.askMeWhereIWantTheChangesToGo"],
  [UncommittedChangesStrategy.MoveToNewBranch, "prefs.alwaysBringMyChangesToMyNewBranch"],
  [UncommittedChangesStrategy.StashOnCurrentBranch, "prefs.alwaysStashAndLeaveMyChangesOnTheCurrentBranch"]
]

/** Desktop preferences/prompts.tsx */
export function PromptsTab() {
  const { t } = useTranslation()
  const preferences = usePreferencesStore()
  return (
    <FieldGroup className="px-4">
      <FieldSet>
        <FieldLegend>{t("prefs.showAConfirmationDialogBefore")}</FieldLegend>
        <FieldGroup className="gap-3">
          {PROMPTS.map(([prompt, label]) => (
            <CheckboxField
              key={prompt}
              id={`prompt-${prompt}`}
              label={t(label)}
              checked={preferences[prompt]}
              onChange={value => preferences.setPrompt(prompt, value)}
            />
          ))}
        </FieldGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend id="switch-branch-heading">{t("prefs.ifIHaveChangesAndISwitchBranches")}</FieldLegend>
        <RadioGroup
          aria-labelledby="switch-branch-heading"
          value={preferences.uncommittedChangesStrategy}
          onValueChange={value => preferences.setUncommittedChangesStrategy(value as UncommittedChangesStrategy)}>
          {STRATEGIES.map(([strategy, label]) => (
            <Field key={strategy} orientation="horizontal">
              <RadioGroupItem id={`strategy-${strategy}`} value={strategy} />
              <FieldLabel htmlFor={`strategy-${strategy}`} className="font-normal">
                {t(label)}
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend>{t("prefs.commitLength")}</FieldLegend>
        <CheckboxField
          id="show-commit-length-warning"
          label={t("prefs.showCommitLengthWarning")}
          checked={preferences.showCommitLengthWarning}
          onChange={preferences.setShowCommitLengthWarning}
        />
      </FieldSet>
    </FieldGroup>
  )
}

/** Desktop preferences/notifications.tsx */
export function NotificationsTab() {
  const { t } = useTranslation()
  const enabled = usePreferencesStore(s => s.notificationsEnabled)
  return (
    <FieldGroup className="px-4">
      <FieldSet>
        <FieldLegend>{t("prefs.notifications")}</FieldLegend>
        <CheckboxField
          id="notifications-enabled"
          label={t("prefs.enableNotifications")}
          description={t("prefs.allowsTheDisplayOfNotifications")}
          checked={enabled}
          onChange={usePreferencesStore.getState().setNotificationsEnabled}
        />
      </FieldSet>
    </FieldGroup>
  )
}

/** Desktop preferences/advanced.tsx「Background updates」。
 *  「Usage」（使用统计）本项目不上报统计，不列；凭据管理器与 OpenSSH 选项不在本项目范围。 */
export function BackgroundUpdatesSettings() {
  const { t } = useTranslation()
  const enabled = usePreferencesStore(s => s.repositoryIndicatorsEnabled)
  return (
    <FieldGroup className="px-4 pb-4">
      <FieldSet>
        <FieldLegend>{t("prefs.backgroundUpdates")}</FieldLegend>
        <CheckboxField
          id="repository-indicators-enabled"
          label={t("prefs.showStatusIconsInTheRepositoryList")}
          description={
            <>
              {t("prefs.theseIconsIndicateWhichRepositoriesHaveLocalOrRemoteChanges")}
              <br />
              {t("prefs.turningThisOffWillNotStopThePeriodicFetching")}
            </>
          }
          checked={enabled}
          onChange={usePreferencesStore.getState().setRepositoryIndicatorsEnabled}
        />
      </FieldSet>
    </FieldGroup>
  )
}

/** Desktop preferences/accessibility.tsx */
export function AccessibilityTab() {
  const { t } = useTranslation()
  const checkMarks = usePreferencesStore(s => s.showDiffCheckMarks)
  const underlineLinks = usePreferencesStore(s => s.underlineLinks)
  return (
    <FieldGroup className="px-4">
      <FieldSet>
        <FieldLegend>{t("prefs.accessibility")}</FieldLegend>
        <CheckboxField
          id="underline-links"
          label={t("prefs.underlineLinks")}
          description={t("prefs.whenEnabledGitCubWillUnderlineLinks")}
          checked={underlineLinks}
          onChange={usePreferencesStore.getState().setUnderlineLinks}
        />
        <CheckboxField
          id="diff-check-marks"
          label={t("prefs.showCheckMarksInTheDiff")}
          description={t("prefs.whenEnabledCheckMarksWillBeDisplayed")}
          checked={checkMarks}
          onChange={usePreferencesStore.getState().setShowDiffCheckMarks}
        />
      </FieldSet>
    </FieldGroup>
  )
}

const availableTabSizes: number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12]

/** Desktop preferences/appearance.tsx 的 Formatting 与 Miscellaneous。
 *  「总是显示工作树列表」对应原版工具栏的工作树下拉，本项目没有，不列。 */
export function AppearanceFormatting() {
  const { t } = useTranslation()
  const preferences = usePreferencesStore()
  const select = (id: string, label: string, control: React.ReactNode) => (
    <Field orientation="horizontal" className="justify-between">
      <FieldLabel htmlFor={id} className="font-normal">
        {label}
      </FieldLabel>
      {control}
    </Field>
  )
  return (
    <FieldGroup className="px-4">
      <FieldSet>
        <FieldLegend>{t("prefs.formatting")}</FieldLegend>
        <FieldGroup className="gap-3">
          {select(
            "date-format",
            t("prefs.dateFormat"),
            <NativeSelect
              id="date-format"
              size="sm"
              value={preferences.dateFormat}
              onChange={event => preferences.setDateFormat(event.currentTarget.value as DateFormat)}>
              {dateFormats.map(({ pattern, example }) => (
                <NativeSelectOption key={pattern} value={pattern}>
                  {example} ({pattern})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          {select(
            "time-format",
            t("prefs.timeFormat"),
            <NativeSelect
              id="time-format"
              size="sm"
              value={preferences.timeFormat}
              onChange={event => preferences.setTimeFormat(event.currentTarget.value as TimeFormat)}>
              {timeFormats.map(({ pattern, example }) => (
                <NativeSelectOption key={pattern} value={pattern}>
                  {example} ({pattern})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          {select(
            "number-format",
            t("prefs.numberFormat"),
            <NativeSelect
              id="number-format"
              size="sm"
              value={numberFormatToKey(preferences.numberFormat)}
              onChange={event => preferences.setNumberFormat(numberFormatFromKey(event.currentTarget.value))}>
              {numberFormats.map(format => (
                <NativeSelectOption key={numberFormatToKey(format)} value={numberFormatToKey(format)}>
                  {formatNumber(1234567.89, format)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          <CheckboxField
            id="prefer-absolute-dates"
            label={t("prefs.preferAbsoluteDatesOverRelative")}
            checked={preferences.preferAbsoluteDates}
            onChange={preferences.setPreferAbsoluteDates}
          />
        </FieldGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend>{t("prefs.miscellaneous")}</FieldLegend>
        {select(
          "diff-tab-size",
          t("prefs.diffTabSize"),
          <NativeSelect
            id="diff-tab-size"
            size="sm"
            value={String(preferences.tabSize)}
            onChange={event => preferences.setTabSize(Number(event.currentTarget.value))}>
            {availableTabSizes.map(n => (
              <NativeSelectOption key={n} value={n}>
                {n === tabSizeDefault ? t("prefs.tabSizeDefault", { size: n }) : n}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </FieldSet>
    </FieldGroup>
  )
}
