import { useTranslation } from "react-i18next"

import { type Prompt, usePreferencesStore } from "@/features/preferences/store"
import { Checkbox } from "@/ui/base/checkbox"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/ui/base/field"
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

/** Desktop preferences/accessibility.tsx。「链接加下划线」只作用于沙箱 Markdown，本项目没有，不列。 */
export function AccessibilityTab() {
  const { t } = useTranslation()
  const checkMarks = usePreferencesStore(s => s.showDiffCheckMarks)
  return (
    <FieldGroup className="px-4">
      <FieldSet>
        <FieldLegend>{t("prefs.accessibility")}</FieldLegend>
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
