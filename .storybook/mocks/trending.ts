import type { Channel } from "@tauri-apps/api/core"

import type { BrowserState } from "../../src/models/browser"

export function mockTrendingBrowser(): BrowserState {
  return { url: "https://github.com/trending", canGoBack: false, canGoForward: false }
}

const channels = new Map<string, Channel<string>>()
export function mockTrendingWebview(args: unknown) {
  const { session, frame, onLoad } = args as {
    session: string
    frame: { visible: boolean } | null
    onLoad?: Channel<string>
  }
  if (!frame) {
    channels.delete(session)
    return
  }
  if (onLoad) {
    if (!frame.visible || channels.has(session)) throw new Error("Load channel must only be registered at creation")
    channels.set(session, onLoad)
  }
  if (frame.visible) channels.get(session)?.onmessage("finished")
}
