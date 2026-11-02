// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { type IBaseInputDescriptionProps, InputDescription, InputDescriptionType } from "./input-description"

/**
 * An caption element with app-standard styles for captions to be used with inputs.
 *
 * Provide `children` elements to render as the content for the error element.
 */
export class Caption extends React.Component<React.PropsWithChildren<IBaseInputDescriptionProps>> {
  public render() {
    return (
      <InputDescription inputDescriptionType={InputDescriptionType.Caption} {...this.props}>
        {this.props.children}
      </InputDescription>
    )
  }
}
