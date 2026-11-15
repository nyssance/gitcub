import type { MenuTemplate } from "./native-menu"
/** Synchronous structural snapshot for Desktop's immutable AppMenu model. */
export interface NativeMenuSnapshot {
  items: NativeMenuItemSnapshot[]
}
export interface NativeMenuItemSnapshot {
  id: string
  label: string
  type: string
  enabled: boolean
  visible: boolean
  checked: boolean
  accelerator?: string
  role?: string
  submenu?: NativeMenuSnapshot
  getDefaultRoleAccelerator?: () => string | undefined
}
export function snapshotMenu(items: readonly MenuTemplate[]): NativeMenuSnapshot {
  return {
    items: items.map(item => ({
      id: item.id ?? "",
      label: item.label ?? item.role ?? "",
      type: item.submenu ? "submenu" : (item.type ?? "normal"),
      enabled: item.enabled ?? true,
      visible: item.visible ?? true,
      checked: item.checked ?? false,
      accelerator: item.accelerator,
      role: item.role,
      submenu: item.submenu ? snapshotMenu(item.submenu) : undefined
    }))
  }
}
