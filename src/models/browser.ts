export interface BrowserState {
  url: string
  canGoBack: boolean
  canGoForward: boolean
}

export type BrowserAction = "state" | "back" | "forward" | "stop" | "openExternal"
