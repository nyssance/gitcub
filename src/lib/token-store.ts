import { invoke } from "@tauri-apps/api/core"
export const TokenStore = {
  getItem: (service: string, login: string) => invoke<string | null>("token_store_get", { service, login }),
  setItem: (service: string, login: string, value: string) =>
    invoke<void>("token_store_set", { service, login, value }),
  deleteItem: (service: string, login: string) => invoke<boolean>("token_store_delete", { service, login })
}
