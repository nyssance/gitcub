import type { DesktopNotificationPermission } from "../lib/notifications/notification-permission"
import { ipcRenderer } from "../lib/platform-ipc"
export const getNotificationsPermission = () =>
  ipcRenderer.invoke("get-notifications-permission") as Promise<DesktopNotificationPermission>
export const showNotification = (
  title: string,
  body: string,
  userInfo?: import("../models/desktop-alive-event").DesktopAliveEvent
) => ipcRenderer.invoke("show-notification", title, body, userInfo) as Promise<string | null>
export const focusWindow = () => ipcRenderer.send("focus-window")
