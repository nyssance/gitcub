import type { MenuEvent } from "./menu-event"
import type { MenuTemplate } from "./native-menu"
import { emitMenuEvent } from "./native-menu"
export const separator: MenuTemplate = {
  type: "separator"
}

export type ClickHandler = () => Promise<void>
/** Native Tauri window routing; the event union and menu actions are upstream. */
export function emit(name: MenuEvent): ClickHandler {
  return () => emitMenuEvent(name)
}
