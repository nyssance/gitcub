/**
 * Emoji Store —— Desktop appStore.emoji：启动后读一次 emoji 表，补全与 RichText 共用。
 * 读完之前是空表（RichText 把 :shortcode: 原样显示，补全没有候选）。
 */
import { create } from "zustand"

import { readEmoji } from "@/lib/read-emoji"
import type { Emoji } from "@/upstream/lib/emoji"

interface EmojiStore {
  emoji: Map<string, Emoji>
}

export const useEmojiStore = create<EmojiStore>(() => ({ emoji: new Map() }))

let loading: Promise<void> | undefined
/** Desktop loadInitialState 里的 readEmoji：只读一次，失败时保留空表 */
export function loadEmoji() {
  loading ??= readEmoji().then(
    emoji => useEmojiStore.setState({ emoji }),
    error => console.warn("Unexpected issue when trying to read emoji into memory", error)
  )
  return loading
}
