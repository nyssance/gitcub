import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"
import { fn } from "storybook/test"

type Handler = (args: unknown) => unknown
let handlers: Record<string, Handler> = {}

// Presentation fixtures only. Unknown calls reject instead of pretending native work succeeded.
export const nativeCall = fn(async (command: string, _args: unknown) => {
  if (Object.hasOwn(handlers, command)) return handlers[command](_args)
  switch (command) {
    case "has_trackpad":
      return false
    case "global_config_value":
      return null
    case "oauth_default_clients":
      return { "github.com": "storybook-client" }
    case "git_identity":
      return { name: "GitCub Preview", email: "preview@example.test" }
    case "available_integrations":
      return []
    default:
      throw new Error(`No Storybook fixture for native command: ${command}`)
  }
})
export function withNativeFixtures(overrides: Record<string, Handler>) {
  return () => {
    const cleanup = installNativeFixtures()
    handlers = overrides
    return cleanup
  }
}

export function installNativeFixtures() {
  handlers = {}
  nativeCall.mockClear()
  mockIPC((command, args) => nativeCall(command, args), { shouldMockEvents: true })
  return clearMocks
}
