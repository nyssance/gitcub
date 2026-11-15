// Desktop MIT native notification contract.
import type { DesktopNotificationEvent } from "./notification-event-type"

/**
 * Callback for notification events. The specific type of userInfo can be chosen
 * as long as it's a Record<string, unknown>.
 */
export type NotificationCallback<T extends object = Record<string, unknown>> = (
  event: DesktopNotificationEvent,
  id: string,
  userInfo: T
) => void

let globalNotificationCallback: NotificationCallback | null = null

/**
 * This is used internally to handle notification events sent from the native
 * side.
 */
export const notificationCallback: NotificationCallback = (...args) => globalNotificationCallback?.(...args)

/** Sets a handler for notification events. */
export const onNotificationEvent = <T extends object = Record<string, unknown>>(
  callback: NotificationCallback<T> | null
) => {
  globalNotificationCallback = callback as NotificationCallback
}
