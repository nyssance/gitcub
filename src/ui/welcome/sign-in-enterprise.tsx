// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import i18n from "../../lib/i18n"
import type { SignInState } from "../../lib/stores/sign-in-store"
import { WelcomeStep } from "../../models/welcome-step"
import { Button } from "../desktop/button"
import type { SignInDispatcher as Dispatcher } from "../sign-in-contract"
import { SignIn } from "../sign-in/sign-in-flow"

interface ISignInEnterpriseProps {
  readonly dispatcher: Dispatcher
  readonly advance: (step: WelcomeStep) => void
  readonly signInState: SignInState | null
}

/** The Welcome flow step to login to an Enterprise instance. */
export class SignInEnterprise extends React.Component<ISignInEnterpriseProps> {
  public render() {
    const state = this.props.signInState

    if (!state) {
      return null
    }

    return (
      <section className="flex flex-col gap-6" id="sign-in-enterprise" aria-label={i18n.t("welcome.enterpriseTitle")}>
        <h1 className="welcome-title text-2xl font-semibold tracking-tight">{i18n.t("welcome.enterpriseTitle")}</h1>

        <SignIn signInState={state} dispatcher={this.props.dispatcher}>
          <Button onClick={this.cancel}>{i18n.t("common.cancel")}</Button>
        </SignIn>
      </section>
    )
  }

  private cancel = () => {
    this.props.advance(WelcomeStep.Start)
  }
}
