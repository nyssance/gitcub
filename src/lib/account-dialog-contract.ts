import type { Account } from "../models/account"
import type { IAccountTokenExpiration } from "./credential-sessions"
/** The original dialog dispatcher boundary; implementations own account renewal and navigation. */
export interface Dispatcher {
  showEnterpriseSignInDialog(url: string): void
  showDotComSignInDialog(): void
  getAccountTokenExpirationForTesting(account: Account): Promise<IAccountTokenExpiration>
  setAccountTokenExpirationForTesting(account: Account, expiresAt: number | undefined): Promise<IAccountTokenExpiration>
}
