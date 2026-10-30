// Desktop MIT port; platform imports adapted to Tauri.
// 原版是 class 组件；本项目照 ALwith Desktop 用函数组件，行为与原版一致。
import type * as React from "react"

import { executeMenuItemById } from "../../lib/menu/native-menu"
import { SuggestedAction } from "./suggested-action"

interface IMenuBackedSuggestedActionProps {
  /**
   * The id of the menu item backing this action.
   * When the action is invoked the menu item specified
   * by this id will be executed.
   */
  readonly menuItemId: string

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
  readonly discoverabilityContent: string | React.JSX.Element

  /**
   * The text, or "label", for the action button.
   */
  readonly buttonText: string | React.JSX.Element

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
   * A callback which is invoked when the user clicks
   * or activates the action using their keyboard.
   *
   * In order to suppress the menu backed action from being invoked
   * consumers of this event will need to suppress the default behavior
   * by calling `e.preventDefault`.
   */
  readonly onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
}

/**
 * A small container component for rendering an "action" in a
 * suggested actions view. An action is usually contained within an action group
 * which visually connects one or more actions. An action component
 * has a title, a description, and a button label.
 *
 * A menu backed suggested action differs from a normal suggested
 * action in that it's directly linked to a menu item in the
 * application menu and invoking a menu backed action will execute
 * the menu item backing it without a need for consumers to specify
 * an onClick callback.
 */
export function MenuBackedSuggestedAction(props: IMenuBackedSuggestedActionProps) {
  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (props.onClick !== undefined) {
      props.onClick(e)
    }

    if (!e.defaultPrevented) {
      executeMenuItemById(props.menuItemId)
    }
  }
  return (
    <SuggestedAction
      title={props.title}
      description={props.description}
      discoverabilityContent={props.discoverabilityContent}
      buttonText={props.buttonText}
      onClick={onClick}
      type={props.type}
      disabled={props.disabled}
    />
  )
}
