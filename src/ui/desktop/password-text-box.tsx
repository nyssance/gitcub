// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"
import { Button } from "./button"
import { type ITextBoxProps, TextBox } from "./text-box"

interface IPasswordTextBoxState {
  /**
   * Whether or not the password is currently visible in the underlying input
   */
  readonly showPassword: boolean
}

/** An password input element with app-standard styles and a button for toggling
 * the visibility of the user password. */
export class PasswordTextBox extends React.Component<ITextBoxProps, IPasswordTextBoxState> {
  private textBoxRef = React.createRef<TextBox>()

  public constructor(props: ITextBoxProps) {
    super(props)

    this.state = { showPassword: false }
  }

  private onTogglePasswordVisibility = () => {
    this.setState({ showPassword: !this.state.showPassword })
    // Preserve the original Desktop implementation and contract.
    this.textBoxRef.current!.focus()
  }

  public render() {
    const buttonIcon = this.state.showPassword ? octicons.eye : octicons.eyeClosed
    const type = this.state.showPassword ? "text" : "password"
    // eslint-disable-next-line unicorn/no-useless-spread -- Preserve the original Desktop implementation.
    const props: ITextBoxProps = { ...this.props, ...{ type } }
    return (
      <div className="password-text-box">
        <TextBox {...props} ref={this.textBoxRef} />
        <Button
          ariaLabel="Toggle password visibility"
          tooltip="Toggle password visibility"
          onClick={this.onTogglePasswordVisibility}
          ariaPressed={this.state.showPassword}>
          <Octicon symbol={buttonIcon} />
        </Button>
      </div>
    )
  }
}
