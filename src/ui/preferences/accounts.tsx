import { platform } from "@tauri-apps/plugin-os"
// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { getHTMLURL } from "../../lib/api"
import { lookupPreferredEmail } from "../../lib/email"
import { type Account, isDotComAccount, isEnterpriseAccount } from "../../models/account"
import type { IAvatarUser } from "../../models/avatar"
import { assertNever } from "../../upstream/lib/fatal-error"
import { Avatar } from "../desktop/avatar"
import { Button } from "../desktop/button"
import { CallToAction } from "../desktop/call-to-action"
import { DialogContent, DialogPreferredFocusClassName } from "../desktop/dialog"
import { Row } from "../desktop/row"

interface IAccountsProps {
  readonly accounts: ReadonlyArray<Account>

  readonly onDotComSignIn: () => void
  readonly onEnterpriseSignIn: () => void
  readonly onLogout: (account: Account) => void
}

enum SignInType {
  DotCom,
  Enterprise
}

// Preserve the original Desktop implementation and contract.
export class Accounts extends React.Component<IAccountsProps, Record<string, never>> {
  public render() {
    const { accounts } = this.props
    const dotComAccount = accounts.find(isDotComAccount)

    return (
      <DialogContent className="accounts-tab">
        <h2>GitHub.com</h2>
        {dotComAccount ? this.renderAccount(dotComAccount, SignInType.DotCom) : this.renderSignIn(SignInType.DotCom)}

        <h2>GitHub Enterprise</h2>
        {this.renderMultipleEnterpriseAccounts()}
      </DialogContent>
    )
  }

  private renderMultipleEnterpriseAccounts() {
    const enterpriseAccounts = this.props.accounts.filter(isEnterpriseAccount)

    return (
      <>
        {enterpriseAccounts.map(account => {
          return this.renderAccount(account, SignInType.Enterprise)
        })}
        {enterpriseAccounts.length === 0 ? (
          this.renderSignIn(SignInType.Enterprise)
        ) : (
          <Button onClick={this.props.onEnterpriseSignIn}>Add GitHub Enterprise account</Button>
        )}
      </>
    )
  }

  private renderAccount(account: Account, type: SignInType) {
    const avatarUser: IAvatarUser = {
      name: account.name,
      email: lookupPreferredEmail(account),
      avatarURL: account.avatarURL,
      endpoint: account.endpoint
    }

    // The DotCom account is shown first, so its sign in/out button should be
    // focused initially when the dialog is opened.
    const className = type === SignInType.DotCom ? DialogPreferredFocusClassName : undefined

    return (
      <Row className="account-info">
        <div className="user-info-container">
          <Avatar accounts={this.props.accounts} user={avatarUser} />
          <div className="user-info">
            {isEnterpriseAccount(account) ? (
              <>
                <div className="account-title">
                  {account.name === account.login ? `@${account.login}` : `@${account.login} (${account.name})`}
                </div>
                <div className="endpoint">{getHTMLURL(account.endpoint)}</div>
              </>
            ) : (
              <>
                <div className="name">{account.name}</div>
                <div className="login">@{account.login}</div>
              </>
            )}
          </div>
        </div>
        <Button onClick={this.logout(account)} className={className}>
          {platform() === "macos" ? "Sign Out" : "Sign out"}
        </Button>
      </Row>
    )
  }

  private onDotComSignIn = () => {
    this.props.onDotComSignIn()
  }

  private onEnterpriseSignIn = () => {
    this.props.onEnterpriseSignIn()
  }

  private renderSignIn(type: SignInType) {
    const signInTitle = platform() === "macos" ? "Sign Into" : "Sign into"
    switch (type) {
      case SignInType.DotCom: {
        return (
          <CallToAction
            actionTitle={`${signInTitle} GitHub.com`}
            onAction={this.onDotComSignIn}
            // The DotCom account is shown first, so its sign in/out button should be
            // focused initially when the dialog is opened.
            buttonClassName={DialogPreferredFocusClassName}>
            <div>Sign in to your GitHub.com account to access your repositories.</div>
          </CallToAction>
        )
      }
      case SignInType.Enterprise:
        return (
          <CallToAction actionTitle={`${signInTitle} GitHub Enterprise`} onAction={this.onEnterpriseSignIn}>
            <div>If you are using GitHub Enterprise at work, sign in to it to get access to your repositories.</div>
          </CallToAction>
        )
      default:
        return assertNever(type, `Unknown sign in type: ${type}`)
    }
  }

  private logout = (account: Account) => {
    return () => {
      this.props.onLogout(account)
    }
  }
}
