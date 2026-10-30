/**
 * Preferences Store —— 原版 Preferences 里存在 localStorage 的那些设置（提示、提交长度警告、
 * 未提交改动的处理方式、无障碍、diff 制表符宽度）。
 *
 * 键名与默认值照搬 Desktop app-store.ts（confirmRepoRemoval 等），从 Desktop 习惯迁过来的人
 * 不会对不上；每个 setter 对应原版 dispatcher.setXxxSetting，改了立即写回。
 */
import { create } from "zustand"

import { getDesktopRuntime } from "@/lib/desktop-runtime"
import { getNotificationsEnabled } from "@/lib/notifications/settings"
import {
  type DateFormat,
  getDateFormatPreference,
  getNumberFormatPreference,
  getPreferAbsoluteDates,
  getTimeFormatPreference,
  type INumberFormat,
  setDateFormatPreference,
  setNumberFormatPreference,
  setPreferAbsoluteDates,
  setTimeFormatPreference,
  type TimeFormat
} from "@/models/formatting-preferences"
import { getBoolean, getEnum, getNumber, setBoolean, setNumber } from "@/upstream/lib/local-storage"
import {
  defaultUncommittedChangesStrategy,
  UncommittedChangesStrategy
} from "@/upstream/models/uncommitted-changes-strategy"

/** 设置页签，顺序照原版 PreferencesTab（Copilot 不在范围）；触控板是本项目独有，排在最后 */
export const PreferencesTabs = [
  "accounts",
  "integrations",
  "git",
  "appearance",
  "notifications",
  "prompts",
  "advanced",
  "accessibility",
  "trackpad"
] as const
export type PreferencesTab = (typeof PreferencesTabs)[number]

/** 原版 Prompts 页里每个「操作前确认」的键与默认值（app-store.ts confirmXxxKey / confirmXxxDefault） */
export const PromptKeys = {
  confirmRepoRemoval: ["confirmRepoRemoval", true],
  confirmDiscardChanges: ["confirmDiscardChanges", true],
  confirmDiscardStash: ["confirmDiscardStash", true],
  confirmForcePush: ["confirmForcePush", true],
  confirmUndoCommit: ["confirmUndoCommit", true],
  confirmCommitFilteredChanges: ["confirmCommitFilteredChangesKey", true],
  confirmWorktreeRemoval: ["confirmWorktreeRemoval", true]
} as const satisfies Record<string, readonly [string, boolean]>

export type Prompt = keyof typeof PromptKeys

const showCommitLengthWarningKey = "showCommitLengthWarning"
const uncommittedChangesStrategyKey = "uncommittedChangesStrategyKind"
const showDiffCheckMarksKey = "diff-check-marks-visible"
const underlineLinksKey = "underline-links"
const tabSizeKey = "tab-size"
export const tabSizeDefault = 4
const repositoryIndicatorsEnabledKey = "enable-repository-indicators"

type Prompts = Record<Prompt, boolean>

interface PreferencesStore extends Prompts {
  showCommitLengthWarning: boolean
  uncommittedChangesStrategy: UncommittedChangesStrategy
  showDiffCheckMarks: boolean
  /** 原版在应用根节点加 underline-links 类（_type.scss：.underline-links a 加下划线） */
  underlineLinks: boolean
  /** 原版设在应用根节点的 CSS tab-size */
  tabSize: number
  /** 原版「外观 › Formatting」：formatDate / formatNumber 每次调用时读 localStorage，这里只同步显示 */
  dateFormat: DateFormat
  timeFormat: TimeFormat
  numberFormat: INumberFormat
  preferAbsoluteDates: boolean
  /** 原版「高级 › 后台更新」：仓库列表的状态图标（AppStore 的 RepositoryIndicatorUpdater） */
  repositoryIndicatorsEnabled: boolean
  /** 原版「通知」：NotificationsStore 的高信号通知 */
  notificationsEnabled: boolean
  setPrompt: (prompt: Prompt, value: boolean) => void
  setShowCommitLengthWarning: (value: boolean) => void
  setUncommittedChangesStrategy: (value: UncommittedChangesStrategy) => void
  setShowDiffCheckMarks: (value: boolean) => void
  setUnderlineLinks: (value: boolean) => void
  setTabSize: (value: number) => void
  setDateFormat: (value: DateFormat) => void
  setTimeFormat: (value: TimeFormat) => void
  setNumberFormat: (value: INumberFormat) => void
  setPreferAbsoluteDates: (value: boolean) => void
  setRepositoryIndicatorsEnabled: (value: boolean) => void
  setNotificationsEnabled: (value: boolean) => void
}

function loadPrompts(): Prompts {
  const prompts = {} as Prompts
  for (const [prompt, [key, fallback]] of Object.entries(PromptKeys))
    prompts[prompt as Prompt] = getBoolean(key, fallback)
  return prompts
}

// 原版打算把默认值改成 false，先把当前行为（true）落盘，免得以后改默认影响老用户
if (getBoolean(showCommitLengthWarningKey) === undefined) setBoolean(showCommitLengthWarningKey, true)

export const usePreferencesStore = create<PreferencesStore>()(set => ({
  ...loadPrompts(),
  showCommitLengthWarning: getBoolean(showCommitLengthWarningKey, false),
  uncommittedChangesStrategy:
    getEnum(uncommittedChangesStrategyKey, UncommittedChangesStrategy) ?? defaultUncommittedChangesStrategy,
  showDiffCheckMarks: getBoolean(showDiffCheckMarksKey, true),
  underlineLinks: getBoolean(underlineLinksKey, true),
  tabSize: getNumber(tabSizeKey, tabSizeDefault),
  dateFormat: getDateFormatPreference(),
  timeFormat: getTimeFormatPreference(),
  numberFormat: getNumberFormatPreference(),
  preferAbsoluteDates: getPreferAbsoluteDates(),
  repositoryIndicatorsEnabled: getBoolean(repositoryIndicatorsEnabledKey, true),
  notificationsEnabled: getNotificationsEnabled(),
  setPrompt: (prompt, value) => {
    setBoolean(PromptKeys[prompt][0], value)
    set({ [prompt]: value } as Pick<Prompts, Prompt>)
  },
  setShowCommitLengthWarning: value => {
    setBoolean(showCommitLengthWarningKey, value)
    set({ showCommitLengthWarning: value })
  },
  setUncommittedChangesStrategy: value => {
    localStorage.setItem(uncommittedChangesStrategyKey, value)
    set({ uncommittedChangesStrategy: value })
  },
  setShowDiffCheckMarks: value => {
    setBoolean(showDiffCheckMarksKey, value)
    set({ showDiffCheckMarks: value })
  },
  setUnderlineLinks: value => {
    setBoolean(underlineLinksKey, value)
    set({ underlineLinks: value })
  },
  setTabSize: value => {
    setNumber(tabSizeKey, value)
    set({ tabSize: value })
  },
  setDateFormat: value => {
    setDateFormatPreference(value)
    set({ dateFormat: value })
  },
  setTimeFormat: value => {
    setTimeFormatPreference(value)
    set({ timeFormat: value })
  },
  setNumberFormat: value => {
    setNumberFormatPreference(value)
    set({ numberFormat: value })
  },
  setPreferAbsoluteDates: value => {
    setPreferAbsoluteDates(value)
    set({ preferAbsoluteDates: value })
  },
  // 这两项由已移植的 store 自己落盘并启停后台任务，这里只同步显示
  setRepositoryIndicatorsEnabled: value => {
    getDesktopRuntime().appStore._setRepositoryIndicatorsEnabled(value)
    set({ repositoryIndicatorsEnabled: value })
  },
  setNotificationsEnabled: value => {
    getDesktopRuntime().notificationsStore.setNotificationsEnabled(value)
    set({ notificationsEnabled: value })
  }
}))
