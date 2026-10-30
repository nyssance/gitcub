import { __DARWIN__ } from "../platform-flags"
import { showNativeContextualMenu } from "./contextual-menu"

// Desktop MIT implementation extracted unchanged from lib/menu-item.ts.
export type { IMenuItem, ISerializableMenuItem } from "./menu-item-types"

import type { IMenuItem } from "./menu-item-types"

/**
 * Converts Electron accelerator modifiers to their platform specific
 * name or symbol.
 *
 * Example: CommandOrControl becomes either '⌘' or 'Ctrl' depending on platform.
 *
 * See https://github.com/electron/electron/blob/fb74f55/docs/api/accelerator.md
 */
export function getPlatformSpecificNameOrSymbolForModifier(modifier: string): string {
  switch (modifier.toLowerCase()) {
    case "cmdorctrl":
    case "commandorcontrol":
      return __DARWIN__ ? "⌘" : "Ctrl"

    case "ctrl":
    case "control":
      return __DARWIN__ ? "⌃" : "Ctrl"

    case "shift":
      return __DARWIN__ ? "⇧" : "Shift"
    case "alt":
      return __DARWIN__ ? "⌥" : "Alt"

    // Mac only
    case "cmd":
    case "command":
      return "⌘"
    case "option":
      return "⌥"

    // Special case space because no one would be able to see it
    case " ":
      return "Space"
  }

  // Not a known modifier, likely a normal key
  return modifier
}

/** Show the given menu items in a contextual menu. */
export async function showContextualMenu(items: ReadonlyArray<IMenuItem>) {
  await showNativeContextualMenu(items)
}
