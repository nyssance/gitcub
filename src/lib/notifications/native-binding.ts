import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import type { NotificationCallback } from "./notification-callback"
import type { INotificationOptions } from "./notification-options"
import type { DesktopNotificationPermission } from "./notification-permission"

let removeListener: (() => void) | undefined
export async function initializeNotifications(callback: NotificationCallback, _options: INotificationOptions) {
  removeListener?.()
  removeListener = await listen<{ event: "click"; id: string; userInfo: Record<string, unknown> }>(
    "desktop-notification-event",
    ({ payload }) => callback(payload.event, payload.id, payload.userInfo)
  )
  await invoke("initialize_notifications")
}
export async function terminateNotifications() {
  removeListener?.()
  removeListener = undefined
  await invoke("terminate_notifications")
}
export const getNotificationsPermission = () => invoke<DesktopNotificationPermission>("notifications_permission")
export const requestNotificationsPermission = () => invoke<boolean>("request_notifications_permission")
export const showNotification = (id: string, title: string, body: string, userInfo?: Record<string, unknown>) =>
  invoke<void>("submit_notification", { id, title, body, userInfo: userInfo ?? {} })
export const closeNotification = (id: string) => invoke<void>("close_notification", { id })
