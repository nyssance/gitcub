import { buildDefaultMenuTemplate } from "../lib/menu/build-default-menu"
import { snapshotMenu } from "../lib/menu/snapshot"
import { menuFromElectronMenu } from "../models/app-menu"
import type { EndpointToken } from "../upstream/lib/endpoint-token"

// Tauri shares the renderer's account coordinator with its private image
// requester. Tokens stay in this closure, never in a broadcast window event.
let accounts: readonly EndpointToken[] = []
const accountListeners = new Set<(accounts: readonly EndpointToken[]) => void>()
export function updateAccounts(next: readonly EndpointToken[]) {
  accounts = next.map(account => ({ ...account }))
  for (const listener of accountListeners) listener(accounts)
}
export function subscribeImageAccounts(listener: (accounts: readonly EndpointToken[]) => void) {
  accountListeners.add(listener)
  listener(accounts)
  return () => {
    accountListeners.delete(listener)
  }
}
export function getAppMenu() {
  return menuFromElectronMenu(
    snapshotMenu(
      buildDefaultMenuTemplate({
        selectedExternalEditor: null,
        selectedShell: null,
        askForConfirmationOnForcePush: true,
        askForConfirmationOnRepositoryRemoval: true
      })
    )
  )
}
