// Desktop MIT implementation extracted unchanged from lib/stores/app-store.ts.
import type { Account } from "../../models/account"
import { deleteToken } from "../api"
import type { AccountsStore } from "./accounts-store"
export class AccountActions {
  constructor(private readonly accountsStore: AccountsStore) {}
  public async _removeAccount(account: Account) {
    log.info(`[AppStore] removing account ${account.login} (${account.name}) from store`)
    const current = await this.accountsStore.removeAccount(account)
    if (current?.token) {
      await deleteToken(current)
    }
  }
}
