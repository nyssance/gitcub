import type { DesktopAliveEvent } from "../../models/desktop-alive-event"
export interface NotificationsEventStore {
  onNotificationEventReceived(event: string, id: string, userInfo: DesktopAliveEvent): void
}
