// Desktop MIT port; platform imports adapted to Tauri.

import { platform } from "@tauri-apps/plugin-os"
import * as React from "react"

interface IKeyboardShortCutProps {
  /** Windows/Linux keyboard shortcut */
  readonly keys: ReadonlyArray<string>
  /** MacOS keyboard shortcut */
  readonly darwinKeys: ReadonlyArray<string>
}

export class KeyboardShortcut extends React.Component<IKeyboardShortCutProps> {
  public render() {
    const keys = platform() === "macos" ? this.props.darwinKeys : this.props.keys

    return (
      <>
        {keys.map((k, i) => {
          return (
            // Preserve the original Desktop component contract.
            <React.Fragment key={k + i}>
              <kbd>{k}</kbd>
              {!(platform() === "macos") && i < keys.length - 1 ? <>+</> : null}
            </React.Fragment>
          )
        })}
      </>
    )
  }
}
