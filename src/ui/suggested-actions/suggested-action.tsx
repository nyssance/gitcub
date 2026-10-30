// Desktop MIT port; platform imports adapted to Tauri.
// 原版是 class 组件；本项目照 ALwith Desktop 用函数组件，渲染结构、类名和行为与原版一致。

import classNames from "classnames"
import type * as React from "react"

import { Button } from "../desktop/button"

interface ISuggestedActionProps {
  /**
   * The title, or "header" text for a suggested
   * action.
   */
  readonly title: string

  /**
   * An optional description to be rendered directly
   * underneath the title.
   */
  readonly description?: string | React.JSX.Element

  /**
   * A text or set of elements used to present information
   * to the user about how and where to access the action
   * outside of the suggested action.
   */
  readonly discoverabilityContent?: string | React.JSX.Element

  /**
   * The text, or "label", for the action button.
   */
  readonly buttonText: string | React.JSX.Element

  /**
   * A callback which is invoked when the user clicks
   * or activates the action using their keyboard.
   */
  readonly onClick: (e: React.MouseEvent<HTMLButtonElement>) => void

  /**
   * The type of action, currently supported actions are
   * normal, and primary. Primary actions are visually
   * distinct from normal actions in order to stand out
   * as a highly probable next step action.
   */
  readonly type?: "normal" | "primary"

  /**
   * Whether or not the action should be disabled. Disabling
   * the action means that the button will no longer be
   * clickable.
   */
  readonly disabled?: boolean

  /**
   * An image to illustrate what this component's action does
   */
  readonly image?: React.JSX.Element
}

/**
 * A small container component for rendering a "suggested action",
 * which was first used in the "No Changes" view. An action is
 * usually contained within an `SuggestedActionGroup`, which visually
 * connects one or more actions. An action component has a title,
 * a description, a button label, and an optional image.
 */
export function SuggestedAction(props: ISuggestedActionProps) {
  const primary = props.type === "primary"
  const cn = classNames("suggested-action", { primary })
  const description = props.description === undefined ? undefined : <p className="description">{props.description}</p>
  return (
    <div className={cn}>
      {props.image && <div className="image-wrapper">{props.image}</div>}
      <div className="text-wrapper">
        <h2>{props.title}</h2>
        {description}
        {props.discoverabilityContent && <p className="discoverability">{props.discoverabilityContent}</p>}
      </div>
      <Button type={primary ? "submit" : undefined} onClick={props.onClick} disabled={props.disabled}>
        {props.buttonText}
      </Button>
    </div>
  )
}
