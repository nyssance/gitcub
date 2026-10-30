import type { SignInResult } from "../lib/stores/sign-in-store"
import type { Popup, PopupType } from "../models/popup"
export interface SignInDispatcher {
  removeAccount(account: import("../models/account").Account): Promise<void>
  setSignInEndpoint(url: string, isEndpointFromGit?: boolean): Promise<void>
  requestBrowserAuthentication(): void
  beginEnterpriseSignIn(callback?: (result: SignInResult) => void): void
  beginDotComSignIn(callback?: (result: SignInResult) => void): void
  resetSignInState(): void
  showPopup(popup: Popup): void
  closePopup(type?: PopupType): void
}
