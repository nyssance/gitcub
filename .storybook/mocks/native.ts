import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"
import { expect, fn } from "storybook/test"

type Handler = (args: unknown) => unknown
let handlers: Record<string, Handler> = {}

const unexpectedCommands: string[] = []
export function assertNativeFixtures() {
  expect(unexpectedCommands).toEqual([])
}

// Presentation fixtures only. Unknown calls fail instead of pretending native work succeeded.
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
      unexpectedCommands.push(command)
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
  unexpectedCommands.length = 0
  mockIPC((command, args) => nativeCall(command, args), { shouldMockEvents: true })
  return clearMocks
}
