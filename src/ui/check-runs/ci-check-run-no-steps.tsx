// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import i18n from "../../lib/i18n"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from "../base/empty"
import { Button } from "../desktop/button"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"

const PaperStackImage = "/desktop/paper-stack.svg"

interface ICICheckRunNoStepProps {
  /** Callback to opens check runs target url (maybe GitHub, maybe third party) */
  readonly onViewCheckExternally: () => void
}

/** The CI check no step view. */
export class CICheckRunNoStepItem extends React.PureComponent<ICICheckRunNoStepProps> {
  public render() {
    return (
      <Empty className="ci-check-run-no-steps">
        <EmptyHeader>
          <EmptyMedia>
            <img className="size-16" src={PaperStackImage} alt="" />
          </EmptyMedia>
          <EmptyDescription>{i18n.t("ci.noSteps")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button className="button-with-icon" onClick={this.props.onViewCheckExternally} role="link">
            View check details
            <Octicon symbol={octicons.linkExternal} />
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
}
