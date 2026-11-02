// 命名 KV 存储的前端入口，照搬 ALwith Desktop `src/lib/store.ts` + `TauriHostPort` 的 store 段：
// `@alwith/module-store` 只认一个 StorePort，这里用 Tauri 命令实现它。
import { createStoreClient, type StorePort } from "@alwith/module-store"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

const port: StorePort = {
  storeEntries: (scope, store) => invoke<Record<string, unknown>>("store_entries", { scope, store }),
  async storeSet(scope, store, key, value) {
    await invoke("store_set", { scope, store, key, value })
  },
  async storeDelete(scope, store, key) {
    await invoke("store_delete", { scope, store, key })
  },
  async storeClear(scope, store) {
    await invoke("store_clear", { scope, store })
  },
  async storeReload(scope, store) {
    await invoke("store_reload", { scope, store })
  },
  onStoreChanged: handler =>
    listen<{ store: string; key: string; value: unknown }>("store-changed", event => handler(event.payload))
}

export const { openStore } = createStoreClient(() => port)
export type { AlwithStore, StoreScope } from "@alwith/module-store"
