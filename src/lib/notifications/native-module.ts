import * as native from "./native-binding"
import { supportsNotifications } from "./native-support"
import { notificationCallback } from "./notification-callback"
import type { INotificationOptions } from "./notification-options"
import type { DesktopNotificationPermission } from "./notification-permission"

function getNativeModule() {
  return supportsNotifications() ? native : null
}
/** Initializes the desktop-notifications system. */
export const initializeNotifications: (opts: INotificationOptions) => void = opts =>
  getNativeModule()?.initializeNotifications(notificationCallback, opts)

/** Terminates the desktop-notifications system. */
export const terminateNotifications: () => void = () => getNativeModule()?.terminateNotifications()

/** Gets the current state of the notifications permission. */
export const getNotificationsPermission: () => Promise<DesktopNotificationPermission> = () =>
  getNativeModule()?.getNotificationsPermission() ?? Promise.resolve("default")

/** Requests the user to grant permission to display notifications. */
export const requestNotificationsPermission: () => Promise<boolean> = () =>
  getNativeModule()?.requestNotificationsPermission() ?? Promise.resolve(false)

/**
 * Displays a system notification.
 * @param title Title of the notification
 * @param body Body of the notification
 * @param userInfo (Optional) An object with any information that needs to be
 * passed to the notification callback when the user clicks on the notification.
 * @returns The ID of the notification displayed. This ID can be used to close
 * the notification. Returns null if native submission fails.
 */
export const showNotification: (
  title: string,
  body: string,
  userInfo?: Record<string, unknown>
) => Promise<string | null> = async (...args) => {
  const native = getNativeModule()
  if (native === null) return null
  const id = crypto.randomUUID()
  try {
    await native.showNotification(id, ...args)
  } catch {
    return null
  }
  return id
}

/** Closes the notification with the given ID. */
export const closeNotification: (id: string) => void = (...args) => getNativeModule()?.closeNotification(...args)

export { supportsNotifications } from "./native-support"
