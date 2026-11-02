// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { CallToAction } from "../desktop/call-to-action"
import { DialogContent } from "../desktop/dialog"
import { LinkButton } from "../desktop/link-button"

const HelpURL = "https://help.github.com/articles/about-remote-repositories/"

interface INoRemoteProps {
  /** The function to call when the users chooses to publish. */
  readonly onPublish: () => void
}

/** The component for when a repository has no remote. */
// Preserve the original Desktop implementation and contract.
export class NoRemote extends React.Component<INoRemoteProps, Record<string, never>> {
  public render() {
    return (
      <DialogContent>
        <CallToAction actionTitle="Publish" onAction={this.props.onPublish}>
          <div className="no-remote-publish-message">
            Publish your repository to GitHub. Need help?{" "}
            <LinkButton uri={HelpURL}>Learn more about remote repositories.</LinkButton>
          </div>
        </CallToAction>
      </DialogContent>
    )
  }
}
