/**
 * Dialogs Store —— 应用级弹窗：确认框、填字框、贮藏并切换分支、设置、工作树、新建 PR、发布、丢弃确认。
 *
 * 确认与填字不能用 window.confirm / window.prompt：tauri-plugin-dialog 把 confirm 换成了没授权的异步命令，
 * prompt 在 WKWebView 里直接返回 null。ask / askText 把 resolve 存在这里，对话框点了哪个按钮就回哪个答案。
 */
import { create } from "zustand"

import { resolve, type Updater } from "@/features/effect-runtime"
import { type PreferencesTab, type Prompt, usePreferencesStore } from "@/features/preferences/store"

/** prompt：原版 Prompts 页里对应的那一项；弹窗带「不再显示」，关掉后直接放行 */
type Asking = { message: string; prompt?: Prompt; dontAskAgain: boolean; resolve: (ok: boolean) => void }
type AskingText = { message: string; value: string; resolve: (value: string | null) => void }
type StashPrompt = { name: string; current: string; resolve: (choice: boolean | "carry") => void }

interface DialogsStore {
  asking: Asking | null
  askingText: AskingText | null
  stashPrompt: StashPrompt | null
  prefsOpen: boolean
  prefsTab: PreferencesTab
  worktreesOpen: boolean
  creatingPr: boolean
  publishing: boolean
  /** 等确认丢弃的文件；丢弃不可逆，照原版问一次 */
  discarding: string[] | null
  ask: (message: string, prompt?: Prompt) => Promise<boolean>
  setDontAskAgain: (value: boolean) => void
  answer: (ok: boolean) => void
  askText: (message: string, initial?: string) => Promise<string | null>
  setAskingTextValue: (value: string) => void
  answerText: (value: string | null) => void
  promptStashAndSwitch: (name: string, current: string) => Promise<boolean | "carry">
  answerStashPrompt: (choice: boolean | "carry") => void
  openPreferences: (tab?: PreferencesTab) => void
  setPrefsOpen: (open: boolean) => void
  setWorktreesOpen: (open: boolean) => void
  setCreatingPr: (open: boolean) => void
  setPublishing: (open: boolean) => void
  setDiscarding: (next: Updater<string[] | null>) => void
}

export const useDialogsStore = create<DialogsStore>()((set, get) => ({
  asking: null,
  askingText: null,
  stashPrompt: null,
  prefsOpen: false,
  prefsTab: "accounts",
  worktreesOpen: false,
  creatingPr: false,
  publishing: false,
  discarding: null,
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
  promptStashAndSwitch: (name, current) =>
    new Promise<boolean | "carry">(done => set({ stashPrompt: { name, current, resolve: done } })),
  answerStashPrompt: choice => {
    get().stashPrompt?.resolve(choice)
    set({ stashPrompt: null })
  },
  openPreferences: tab => set(store => ({ prefsOpen: true, prefsTab: tab ?? store.prefsTab })),
  setPrefsOpen: prefsOpen => set({ prefsOpen }),
  setWorktreesOpen: worktreesOpen => set({ worktreesOpen }),
  setCreatingPr: creatingPr => set({ creatingPr }),
  setPublishing: publishing => set({ publishing }),
  setDiscarding: next => set(store => ({ discarding: resolve(next, store.discarding) }))
}))

/** 有弹窗挡在前面时，菜单与快捷键里的仓库操作按忙处理。 */
export const selectDialogBlocking = (store: DialogsStore) =>
  !!store.asking ||
  !!store.askingText ||
  !!store.stashPrompt ||
  store.prefsOpen ||
  store.creatingPr ||
  store.publishing ||
  store.worktreesOpen
