import { createContext, useContext } from "react"

import { type Prompt, PromptKeys, usePreferencesStore } from "@/features/preferences/store"

/** Desktop preferences.tsx 把各页签的值放在对话框 state 里，点「保存」（onSave）才逐项写回，
 *  点「取消」直接丢弃。这里是同一个约定：页签只改草稿，保存时统一提交。 */

type Store = ReturnType<typeof usePreferencesStore.getState>
/** preferences store 里能在设置页改的值（去掉 setter） */
export type PreferenceValues = {
  [K in keyof Store as Store[K] extends (...args: never[]) => unknown ? never : K]: Store[K]
}

export interface PreferencesDraft {
  /** 草稿覆盖在当前值上 */
  values: PreferenceValues
  set: <K extends keyof PreferenceValues>(key: K, value: PreferenceValues[K]) => void
  /** 不在 store 里的设置（git config、钩子环境等）：登记保存时要执行的写入，同一个 key 后登记的覆盖先登记的 */
  stage: (key: string, apply: () => Promise<void> | void) => void
  /** 有校验错误时禁用「保存」（Desktop disallowedCharactersMessage → okButtonDisabled） */
  setInvalid: (key: string, invalid: boolean) => void
}

export const PreferencesDraftContext = createContext<PreferencesDraft | null>(null)

export function usePreferencesDraft(): PreferencesDraft {
  const draft = useContext(PreferencesDraftContext)
  if (!draft) throw new Error("usePreferencesDraft must be used inside Preferences")
  return draft
}

/** 保存：每个改过的值调用 store 里对应的 setter（照 Desktop onSave 的 dispatcher.setXxx） */
export function applyPreference<K extends keyof PreferenceValues>(key: K, value: PreferenceValues[K]) {
  const store = usePreferencesStore.getState()
  if (key in PromptKeys) {
    store.setPrompt(key as Prompt, value as boolean)
    return
  }
  const setter = `set${key[0].toUpperCase()}${key.slice(1)}` as keyof Store
  ;(store[setter] as (value: PreferenceValues[K]) => void)(value)
}
