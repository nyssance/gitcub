// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import i18n from "../../lib/i18n"
import { WelcomeStep } from "../../models/welcome-step"
import { LinkButton } from "../desktop/link-button"

interface Dispatcher {
  requestBrowserAuthenticationToDotcom(): void
}

import { SamplesURL } from "../../lib/stats/index"
import { Button } from "../desktop/button"
import { Loading } from "../desktop/loading"
import { Octicon } from "../octicons/index"
import * as octicons from "../octicons/octicons.generated"

/**
 * The URL to the sign-up page on GitHub.com. Used in conjunction
 * with account actions in the app where the user might want to
 * consider signing up.
 */
export const CreateAccountURL = "https://github.com/join?source=github-desktop"

interface IStartProps {
  readonly advance: (step: WelcomeStep) => void
  readonly dispatcher: Dispatcher
  readonly loadingBrowserAuth: boolean
}

/** The first step of the Welcome flow. */
export class Start extends React.Component<IStartProps, Record<string, never>> {
  public render() {
    return (
      <section
        className="flex flex-col gap-6"
        id="start"
        aria-label={i18n.t("welcome.title")}
        aria-describedby="start-description">
        <div className="start-content flex flex-col gap-6">
          <h1 className="welcome-title text-2xl font-semibold tracking-tight">{i18n.t("welcome.title")}</h1>
          {!this.props.loadingBrowserAuth ? (
            <>
              <p id="start-description" className="welcome-text text-muted-foreground text-sm">
                {i18n.t("welcome.description")}
              </p>
            </>
          ) : (
            <p>{i18n.t("welcome.browserRedirect")}</p>
          )}

          <div className="welcome-main-buttons flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              type="submit"
              className="button-with-icon"
              disabled={this.props.loadingBrowserAuth}
              onClick={this.signInWithBrowser}
              autoFocus={true}
              role="link">
              {this.props.loadingBrowserAuth && <Loading />}
              {i18n.t("welcome.github")}
              <Octicon symbol={octicons.linkExternal} />
            </Button>
            {this.props.loadingBrowserAuth ? (
              <Button onClick={this.cancelBrowserAuth}>{i18n.t("common.cancel")}</Button>
            ) : (
              <Button onClick={this.signInToEnterprise}>{i18n.t("welcome.enterprise")}</Button>
            )}
          </div>
          <div className="skip-action-container flex flex-col items-start gap-3">
            <LinkButton onClick={this.signInToEnterprise}>{i18n.t("welcome.gitlab")}</LinkButton>
            <p className="welcome-text text-muted-foreground text-sm">
              {i18n.t("welcome.newAccount")}{" "}
              <LinkButton uri={CreateAccountURL} className="create-account-link">
                {i18n.t("welcome.createAccount")}
              </LinkButton>
            </p>
            <LinkButton className="skip-button" onClick={this.skip}>
              {i18n.t("welcome.skip")}
            </LinkButton>
          </div>
        </div>

        <div className="start-footer text-muted-foreground flex flex-col gap-2 text-xs">
          <p>
            {i18n.t("welcome.termsIntro")}{" "}
            <LinkButton uri={"https://github.com/site/terms"}>{i18n.t("welcome.terms")}</LinkButton>
            {i18n.t("welcome.privacyIntro")}{" "}
            <LinkButton uri={"https://github.com/site/privacy"}>{i18n.t("welcome.privacy")}</LinkButton>
          </p>
          <p>
            {i18n.t("welcome.metricsIntro")} <LinkButton uri={SamplesURL}>{i18n.t("welcome.metrics")}</LinkButton>
          </p>
        </div>
      </section>
    )
  }

  private signInWithBrowser = (event?: React.MouseEvent<HTMLButtonElement>) => {
    if (event) {
      event.preventDefault()
    }

    this.props.advance(WelcomeStep.SignInToDotComWithBrowser)
    this.props.dispatcher.requestBrowserAuthenticationToDotcom()
  }

  private cancelBrowserAuth = () => {
    this.props.advance(WelcomeStep.Start)
  }

  private signInToEnterprise = () => {
    this.props.advance(WelcomeStep.SignInToEnterprise)
  }

  private skip = () => {
    this.props.advance(WelcomeStep.ConfigureGit)
  }
}
