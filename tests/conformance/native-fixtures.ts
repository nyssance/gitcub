// 组件测试的原生命令替身：照原 .storybook/mocks/native.ts，按命令名给结果，未知命令一律拒绝，
// 不假装原生操作成功。src 里的 invoke 在测试里映射到 tauri.ts（转到这里），
// @tauri-apps/api 自己的事件与插件走 window.__TAURI_INTERNALS__（mockIPC 装上）。
import { mock } from "bun:test"

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"

type Handler = (args: Record<string, unknown>) => unknown
let handlers: Record<string, Handler> = {}
// Desktop 仓库库等命名 JSON 存储的内存替身（照 tauri.ts 的 namedStores），每次装替身清空
const stores = new Map<string, Record<string, unknown>>()
const storeId = (args: Record<string, unknown>) => `${args.scope}/${args.store}`

export const nativeCall = mock(async (command: string, args: unknown) => {
  if (Object.hasOwn(handlers, command)) return handlers[command](args as Record<string, unknown>)
  switch (command) {
    case "has_trackpad":
      return false
    case "global_config_value":
      return null
    case "oauth_default_clients":
      return { "github.com": "test-client" }
    case "git_identity":
      return { name: "GitCub Test", email: "test@example.test" }
    case "available_integrations":
      return []
    case "store_entries":
      return { ...stores.get(storeId(args as Record<string, unknown>)) }
    case "store_set": {
      const { key, value } = args as { key: string; value: unknown }
      const id = storeId(args as Record<string, unknown>)
      stores.set(id, { ...stores.get(id), [key]: value })
      return
    }
    case "store_delete": {
      const id = storeId(args as Record<string, unknown>)
      const { [(args as { key: string }).key]: _, ...rest } = stores.get(id) ?? {}
      stores.set(id, rest)
      return
    }
    case "store_clear":
      stores.delete(storeId(args as Record<string, unknown>))
      return
    case "store_reload":
      return
    default:
      throw new Error(`No test fixture for native command: ${command}`)
  }
})

/** 装上命令替身，返回卸载函数（afterEach 里调） */
export function installNativeFixtures(overrides: Record<string, Handler> = {}) {
  handlers = overrides
  stores.clear()
  nativeCall.mockClear()
  mockIPC((command, args) => nativeCall(command, args), { shouldMockEvents: true })
  ;(globalThis as { __gitcubNativeFixtures?: unknown }).__gitcubNativeFixtures = (command: string, args: unknown) =>
    nativeCall(command, args)
  return () => {
    clearMocks()
    delete (globalThis as { __gitcubNativeFixtures?: unknown }).__gitcubNativeFixtures
  }
}

/** 某个命令收到过的参数，按调用顺序 */
export const callsOf = (command: string) =>
  nativeCall.mock.calls.filter(([name]) => name === command).map(([, args]) => args as Record<string, unknown>)

export const pending = () => new Promise<never>(() => {})
export const unavailable = () => {
  throw new Error("Preview service unavailable")
}
