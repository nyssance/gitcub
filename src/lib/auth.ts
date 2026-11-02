// Desktop MIT port; platform imports adapted to Tauri.
import type { Account } from "../models/account"

/** Get the auth key for the user. */
export function getKeyForAccount(account: Account): string {
  return getKeyForEndpoint(account.endpoint)
}

/** Get the auth key for the endpoint. */
export function getKeyForEndpoint(endpoint: string): string {
  const appName = import.meta.env?.DEV ? "GitCub Dev" : "GitCub"

  return `${appName} - ${endpoint}`
}
