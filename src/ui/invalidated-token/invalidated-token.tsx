import { platform } from "@tauri-apps/plugin-os"
// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import type { Dispatcher } from "../../lib/account-dialog-contract"
import { getHTMLURL } from "../../lib/api"
import { type Account, isEnterpriseAccount } from "../../models/account"
import { Dialog, DialogContent, DialogFooter } from "../desktop/dialog"
import { OkCancelButtonGroup } from "../desktop/dialog/ok-cancel-button-group"
import { Ref } from "../desktop/ref"

interface IInvalidatedTokenProps {
  readonly dispatcher: Pick<Dispatcher, "showEnterpriseSignInDialog" | "showDotComSignInDialog">
  readonly account: Account
  readonly onDismissed: () => void
}

/**
 * Dialog that alerts user that their GitHub (Enterprise) account token is not
 * valid and they need to sign in again.
 */
export class InvalidatedToken extends React.Component<IInvalidatedTokenProps> {
  public render() {
    const { account } = this.props

    return (
      <Dialog
        id="invalidated-token"
        type="warning"
        title={platform() === "macos" ? "Invalidated Account Token" : "Invalidated account token"}
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}>
        <DialogContent>
          Your account token is no longer valid and you have been signed out from your{" "}
          <Ref>{account.friendlyEndpoint}</Ref> account. Do you want to sign in again?
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup okButtonText="Yes" cancelButtonText="No" />
        </DialogFooter>
      </Dialog>
    )
  }

  private onSubmit = () => {
    const { dispatcher, onDismissed, account } = this.props

    onDismissed()

    if (isEnterpriseAccount(account)) {
      dispatcher.showEnterpriseSignInDialog(getHTMLURL(this.props.account.endpoint))
    } else {
      dispatcher.showDotComSignInDialog()
    }
  }
}
