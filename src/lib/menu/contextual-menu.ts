import type { IMenuItem } from "./menu-item-types"
import { Menu, type MenuTemplate, type NativeMenu } from "./native-menu"

let currentMenu: NativeMenu | undefined

/** Tauri delivers selection through item actions, not Electron's IPC result. */
export async function showNativeContextualMenu(items: readonly IMenuItem[]) {
  const convert = (items: readonly IMenuItem[]): MenuTemplate[] =>
    items.map(item => ({
      label: item.label,
      type: item.type,
      checked: item.checked,
      enabled: item.enabled,
      role: item.role,
      click: item.action,
      submenu: item.submenu ? convert(item.submenu) : undefined
    }))
  const menu = await Menu.buildFromTemplate(convert(items))
  const previous = currentMenu
  currentMenu = menu
  await previous?.close()
  await menu.popup()
}
