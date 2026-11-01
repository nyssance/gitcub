// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { Spinner } from "@/components/ui/spinner"

/** A Loading component. */
// Preserve the original Desktop component contract.
export class Loading extends React.Component<Record<string, never>, Record<string, never>> {
  public render() {
    return <Spinner className="octicon spin" aria-hidden="true" />
  }
}
