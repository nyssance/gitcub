// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import i18n from "../../lib/i18n"
import type { Account } from "../../models/account"
import { WelcomeStep } from "../../models/welcome-step"
import { Button } from "../desktop/button"
import { ConfigureGitUser } from "../preferences/configure-git-user"

interface IConfigureGitProps {
  readonly accounts: ReadonlyArray<Account>
  readonly advance: (step: WelcomeStep) => void
  readonly done: () => void
  readonly globalUserName: string | undefined
  readonly globalUserEmail: string | undefined
}

/** The Welcome flow step to configure git. */
export class ConfigureGit extends React.Component<IConfigureGitProps> {
  public render() {
    return (
      <section className="flex flex-col gap-6" id="configure-git" aria-label={i18n.t("welcome.configureGit")}>
        <h1 className="welcome-title text-2xl font-semibold tracking-tight">{i18n.t("welcome.configureGit")}</h1>
        <p className="welcome-text text-muted-foreground text-sm">{i18n.t("welcome.identityDescription")}</p>

        <ConfigureGitUser
          accounts={this.props.accounts}
          onSave={this.props.done}
          saveLabel={i18n.t("welcome.finish")}
          globalUserName={this.props.globalUserName}
          globalUserEmail={this.props.globalUserEmail}>
          <Button onClick={this.cancel}>{i18n.t("common.cancel")}</Button>
        </ConfigureGitUser>
      </section>
    )
  }

  private cancel = () => {
    this.props.advance(WelcomeStep.Start)
  }
}
