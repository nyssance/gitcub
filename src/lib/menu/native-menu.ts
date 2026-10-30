import { invoke } from "@tauri-apps/api/core"
import { emit } from "@tauri-apps/api/event"
import {
  CheckMenuItem,
  Menu as TauriMenu,
  MenuItem,
  PredefinedMenuItem,
  type PredefinedMenuItemOptions,
  Submenu
} from "@tauri-apps/api/menu"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { openUrl } from "@tauri-apps/plugin-opener"

import { getVersion } from "../app-version"
import { __DARWIN__ } from "../platform-flags"
import type { MenuEvent } from "./menu-event"
export type NativeMenu = TauriMenu
export interface MenuTemplate {
  id?: string
  label?: string
  role?: string
  type?: "separator" | "checkbox" | "normal" | "radio"
  enabled?: boolean
  visible?: boolean
  checked?: boolean
  accelerator?: string
  submenu?: MenuTemplate[]
  click?: () => unknown
}
const roles: Record<string, PredefinedMenuItemOptions["item"]> = {
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "SelectAll",
  services: "Services",
  hide: "Hide",
  hideOthers: "HideOthers",
  unhide: "ShowAll",
  quit: "Quit",
  close: "CloseWindow",
  minimize: "Minimize",
  zoom: "Maximize",
  front: "BringAllToFront",
  togglefullscreen: "Fullscreen"
}
const liveItems = new Map<
  string,
  { item: MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu; text: string; enabled: boolean | undefined }
>()
const liveActions = new Map<string, (() => unknown) | undefined>()
let updateQueue = Promise.resolve()
/** Desktop main-process-proxy executeMenuItemById：按 id 触发菜单项的动作（建议动作、空白页按钮用）。 */
export function executeMenuItemById(id: string) {
  const action = liveActions.get(id)
  if (!action) {
    log.error(`Could not find matching menu item for ${id}`)
    return
  }
  void Promise.resolve(action()).catch(error => log.error(`Menu action ${id} failed`, error))
}

/** Update existing native handles; keep accelerators and subscriptions alive. */
export function updateNativeMenu(templates: readonly MenuTemplate[]) {
  updateQueue = updateQueue
    .catch(error => log.error("Native menu update failed", error))
    .then(() => updateChildren(templates))
  return updateQueue
}
async function updateChildren(templates: readonly MenuTemplate[]) {
  for (const template of templates) {
    const live = template.id ? liveItems.get(template.id) : undefined
    if (template.id) liveActions.set(template.id, template.click)
    if (live && template.label !== undefined && template.label !== live.text) {
      await live.item.setText(template.label)
      live.text = template.label
    }
    if (live && template.enabled !== undefined && template.enabled !== live.enabled && "setEnabled" in live.item) {
      await live.item.setEnabled(template.enabled)
      live.enabled = template.enabled
    }
    if (template.submenu) await updateChildren(template.submenu)
  }
}
const invokeAction = (action: () => unknown) => () => {
  Promise.resolve()
    .then(action)
    .catch(error => log.error("Native menu action failed", error))
}
export async function buildItems(
  templates: readonly MenuTemplate[]
): Promise<(MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu)[]> {
  const items: (MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu)[] = []
  for (const template of templates) {
    if (template.visible === false) continue
    const text =
      template.label ??
      (template.role === "help" ? "Help" : template.role === "windowMenu" ? "Window" : (template.role ?? ""))
    const options = {
      id: template.id,
      text,
      enabled: template.enabled,
      accelerator: template.accelerator,
      action: template.click
        ? invokeAction(() => (template.id ? liveActions.get(template.id)?.() : template.click?.()))
        : undefined
    }
    if (template.type === "separator") items.push(await PredefinedMenuItem.new({ item: "Separator" }))
    else if (template.role === "services") items.push(await PredefinedMenuItem.new({ item: "Services" }))
    else if (template.submenu) items.push(await Submenu.new({ ...options, items: await buildItems(template.submenu) }))
    else if (template.role && roles[template.role]) {
      if (!__DARWIN__ && ["undo", "redo", "togglefullscreen"].includes(template.role)) {
        items.push(
          await MenuItem.new({
            ...options,
            action: invokeAction(async () => {
              if (template.role === "togglefullscreen") {
                const w = getCurrentWindow()
                await w.setFullscreen(!(await w.isFullscreen()))
              } else document.execCommand(template.role ?? "")
            })
          })
        )
      } else items.push(await PredefinedMenuItem.new({ text: template.label, item: roles[template.role] }))
    } else if (template.type === "checkbox")
      items.push(await CheckMenuItem.new({ ...options, checked: template.checked ?? false }))
    else items.push(await MenuItem.new(options))
    if (template.id) {
      liveActions.set(template.id, template.click)
      liveItems.set(template.id, { item: items.at(-1)!, text, enabled: template.enabled })
    }
  }
  return items
}
export const Menu = {
  buildFromTemplate: async (template: readonly MenuTemplate[]) => TauriMenu.new({ items: await buildItems(template) })
}
export const shell = { openExternal: openUrl }
export const app = { getVersion }
export const reloadWindow = () => location.reload()
export const toggleDevTools = () => invoke<void>("toggle_devtools")
export async function showLogs() {
  const path = await invoke<string>("ensure_log_directory")
  await invoke("reveal_in_file_manager", { path })
}
const aliases: Partial<Record<MenuEvent, string>> = {
  "show-preferences": "preferences",
  "add-local-repository": "add-repository",
  "create-repository": "new-repository",
  "open-working-directory": "reveal",
  "open-in-shell": "open-in-terminal",
  "open-external-editor": "open-in-editor",
  "view-repository-on-github": "view-on-remote",
  "show-branches": "show-branches-list",
  "choose-repository": "show-repository-list"
}
export async function emitMenuEvent(name: MenuEvent) {
  const window = getCurrentWindow()
  if (!(await window.isVisible())) await window.show()
  await emit("menu-event", [name])
  await emit("menu", aliases[name] ?? name)
}
let zoomFactor = 1
export const getZoomFactor = () => zoomFactor
export async function setZoomFactor(value: number) {
  await getCurrentWebview().setZoom(value)
  zoomFactor = value
  await emit("zoom-factor-changed", [value])
}
