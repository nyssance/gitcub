/**
 * Dialogs Store —— 应用级弹窗：确认框、填字框、贮藏并切换分支、设置、工作树、新建 PR、发布、丢弃确认、钩子失败、提交进度。
 *
 * 确认与填字不能用 window.confirm / window.prompt：tauri-plugin-dialog 把 confirm 换成了没授权的异步命令，
 * prompt 在 WKWebView 里直接返回 null。ask / askText 把 resolve 存在这里，对话框点了哪个按钮就回哪个答案。
 */
import { create } from "zustand"

import { resolve, type Updater } from "@/features/effect-runtime"
import { type PreferencesTab, type Prompt, usePreferencesStore } from "@/features/preferences/store"
import { localChangesOverwrittenHandler, type LocalChangesOverwrittenPopup } from "@/lib/error-handlers"
import type { TerminalOutput, TerminalOutputListener } from "@/lib/git-execution"
import type { CommitOneLine } from "@/models/commit"

/** prompt：原版 Prompts 页里对应的那一项；弹窗带「不再显示」，关掉后直接放行 */
type Asking = { message: string; prompt?: Prompt; dontAskAgain: boolean; resolve: (ok: boolean) => void }
type WarnForcePush = { operation: string; resolve: (begin: boolean) => void }
type AskingText = { message: string; value: string; resolve: (value: string | null) => void }
type StashPrompt = {
  name: string
  current: string
  hasAssociatedStash: boolean
  resolve: (choice: boolean | "carry") => void
}
/** Desktop PopupType.HookFailed */
type HookFailedPrompt = {
  hookName: string
  terminalOutput: TerminalOutput
  resolve: (value: "abort" | "ignore") => void
}

interface DialogsStore {
  asking: Asking | null
  askingText: AskingText | null
  stashPrompt: StashPrompt | null
  prefsOpen: boolean
  prefsTab: PreferencesTab
  worktreesOpen: boolean
  /** Desktop PopupType.RepositorySettings */
  repositorySettingsOpen: boolean
  creatingPr: boolean
  publishing: boolean
  /** 等确认丢弃的文件；丢弃不可逆，照原版问一次 */
  discarding: string[] | null
  hookFailed: HookFailedPrompt | null
  /** Desktop PopupType.Error 的那一串：最早的那个先显示，关掉再显示下一个 */
  errors: readonly Error[]
  /** Desktop _pushError */
  pushError: (error: Error) => void
  /** Desktop _clearError */
  clearError: (error: Error) => void
  /** Desktop dispatcher.postError：先过错误处理器，没被处理的才进错误对话框 */
  postError: (error: Error) => void
  /** Desktop PopupType.DeleteTag */
  deletingTag: string | null
  setDeletingTag: (tagName: string | null) => void
  /** Desktop PopupType.ConfirmCheckoutCommit */
  checkingOutCommit: CommitOneLine | null
  setCheckingOutCommit: (commit: CommitOneLine | null) => void
  /** Desktop PopupType.CreateBranch 带 targetCommit：新建分支对话框归分支下拉管，这里只传要从哪个提交建 */
  createBranchFromCommit: CommitOneLine | null
  setCreateBranchFromCommit: (commit: CommitOneLine | null) => void
  /** Desktop PopupType.LocalChangesOverwritten */
  localChangesOverwritten: LocalChangesOverwrittenPopup | null
  dismissLocalChangesOverwritten: () => void
  /** Desktop PopupType.CommitProgress */
  commitProgress: TerminalOutputListener | null
  ask: (message: string, prompt?: Prompt) => Promise<boolean>
  /** Desktop MultiCommitOperationStepKind.WarnForcePush / PopupType.WarnForcePush：关了「强推前确认」就直接开始 */
  warnForcePush: WarnForcePush | null
  askWarnForcePush: (operation: string) => Promise<boolean>
  /** Desktop WarnForcePushDialog.onBegin 先 setConfirmForcePushSetting 再开始；取消不改设置 */
  answerWarnForcePush: (begin: boolean, askForConfirmationOnForcePush?: boolean) => void
  setDontAskAgain: (value: boolean) => void
  answer: (ok: boolean) => void
  askText: (message: string, initial?: string) => Promise<string | null>
  setAskingTextValue: (value: string) => void
  answerText: (value: string | null) => void
  promptStashAndSwitch: (name: string, current: string, hasAssociatedStash: boolean) => Promise<boolean | "carry">
  answerStashPrompt: (choice: boolean | "carry") => void
  openPreferences: (tab?: PreferencesTab) => void
  setPrefsOpen: (open: boolean) => void
  setWorktreesOpen: (open: boolean) => void
  setRepositorySettingsOpen: (open: boolean) => void
  setCreatingPr: (open: boolean) => void
  setPublishing: (open: boolean) => void
  setDiscarding: (next: Updater<string[] | null>) => void
  /** Desktop AppStore.onHookFailure：弹 HookFailed，等用户选忽略还是中止 */
  askHookFailure: (hookName: string, terminalOutput: TerminalOutput) => Promise<"abort" | "ignore">
  dismissHookFailed: () => void
  setCommitProgress: (subscribeToCommitOutput: TerminalOutputListener | null) => void
}

export const useDialogsStore = create<DialogsStore>()((set, get) => ({
  asking: null,
  askingText: null,
  stashPrompt: null,
  prefsOpen: false,
  prefsTab: "accounts",
  worktreesOpen: false,
  repositorySettingsOpen: false,
  creatingPr: false,
  publishing: false,
  discarding: null,
  hookFailed: null,
  errors: [],
  pushError: error => set(state => ({ errors: [...state.errors, error] })),
  clearError: error => set(state => ({ errors: state.errors.filter(e => e !== error) })),
  postError: error => {
    const localChangesOverwritten = localChangesOverwrittenHandler(error)
    if (localChangesOverwritten) set({ localChangesOverwritten })
    else get().pushError(error)
  },
  deletingTag: null,
  setDeletingTag: deletingTag => set({ deletingTag }),
  checkingOutCommit: null,
  setCheckingOutCommit: checkingOutCommit => set({ checkingOutCommit }),
  createBranchFromCommit: null,
  setCreateBranchFromCommit: createBranchFromCommit => set({ createBranchFromCommit }),
  localChangesOverwritten: null,
  dismissLocalChangesOverwritten: () => set({ localChangesOverwritten: null }),
  commitProgress: null,
  warnForcePush: null,
  askWarnForcePush: operation => {
    if (!usePreferencesStore.getState().confirmForcePush) return Promise.resolve(true)
    return new Promise<boolean>(done => set({ warnForcePush: { operation, resolve: done } }))
  },
  answerWarnForcePush: (begin, askForConfirmationOnForcePush) => {
    if (begin && askForConfirmationOnForcePush !== undefined)
      usePreferencesStore.getState().setPrompt("confirmForcePush", askForConfirmationOnForcePush)
    get().warnForcePush?.resolve(begin)
    set({ warnForcePush: null })
  },
  ask: (message, prompt) => {
    if (prompt && !usePreferencesStore.getState()[prompt]) return Promise.resolve(true)
    return new Promise<boolean>(done => set({ asking: { message, prompt, dontAskAgain: false, resolve: done } }))
  },
  setDontAskAgain: dontAskAgain => set(store => (store.asking ? { asking: { ...store.asking, dontAskAgain } } : store)),
  // 原版只在确认时保存「不再显示」（onSubmit 里 setConfirmXxxSetting），取消不改设置
  answer: ok => {
    const asking = get().asking
    if (ok && asking?.prompt && asking.dontAskAgain) usePreferencesStore.getState().setPrompt(asking.prompt, false)
    asking?.resolve(ok)
    set({ asking: null })
  },
  askText: (message, initial = "") =>
    new Promise<string | null>(done => set({ askingText: { message, value: initial, resolve: done } })),
  setAskingTextValue: value =>
    set(store => (store.askingText ? { askingText: { ...store.askingText, value } } : store)),
  answerText: value => {
    get().askingText?.resolve(value)
    set({ askingText: null })
  },
  promptStashAndSwitch: (name, current, hasAssociatedStash) =>
    new Promise<boolean | "carry">(done => set({ stashPrompt: { name, current, hasAssociatedStash, resolve: done } })),
  answerStashPrompt: choice => {
    get().stashPrompt?.resolve(choice)
    set({ stashPrompt: null })
  },
  openPreferences: tab => set(store => ({ prefsOpen: true, prefsTab: tab ?? store.prefsTab })),
  setPrefsOpen: prefsOpen => set({ prefsOpen }),
  setWorktreesOpen: worktreesOpen => set({ worktreesOpen }),
  setRepositorySettingsOpen: repositorySettingsOpen => set({ repositorySettingsOpen }),
  setCreatingPr: creatingPr => set({ creatingPr }),
  setPublishing: publishing => set({ publishing }),
  setDiscarding: next => set(store => ({ discarding: resolve(next, store.discarding) })),
  askHookFailure: (hookName, terminalOutput) =>
    new Promise<"abort" | "ignore">(done => set({ hookFailed: { hookName, terminalOutput, resolve: done } })),
  dismissHookFailed: () => set({ hookFailed: null }),
  setCommitProgress: commitProgress => set({ commitProgress })
}))

/** Desktop AppStore.onHookFailure：钩子失败时弹 HookFailed；选了中止，这次操作随之失败但不再报错
 *  （原版 `.catch(err => (aborted ? undefined : Promise.reject(err)))`） */
export function hookFailureHandling() {
  let aborted = false
  return {
    onHookFailure: (hookName: string, terminalOutput: TerminalOutput) =>
      useDialogsStore
        .getState()
        .askHookFailure(hookName, terminalOutput)
        .then(resolution => {
          if (resolution === "abort") aborted = true
          return resolution
        }),
    ignoreAborted: <T>(operation: Promise<T>, fallback: T) =>
      operation.catch((error: unknown) => {
        if (aborted) return fallback
        throw error
      })
  }
}

/** 有弹窗挡在前面时，菜单与快捷键里的仓库操作按忙处理。 */
export const selectDialogBlocking = (store: DialogsStore) =>
  !!store.asking ||
  !!store.askingText ||
  !!store.stashPrompt ||
  store.prefsOpen ||
  store.creatingPr ||
  store.publishing ||
  store.worktreesOpen ||
  store.repositorySettingsOpen ||
  !!store.hookFailed ||
  !!store.commitProgress
