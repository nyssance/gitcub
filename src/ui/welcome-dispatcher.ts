import type { SignInDispatcher } from "./sign-in-contract"
export interface WelcomeDispatcher extends SignInDispatcher {
  recordWelcomeWizardInitiated(): void
  requestBrowserAuthenticationToDotcom(): void
  endWelcomeFlow(): void
}
