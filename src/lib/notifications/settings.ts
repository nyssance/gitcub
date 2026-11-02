// Desktop notification preferences, shared without loading the coordinator.
import { getBoolean } from "../../upstream/lib/local-storage"
export const NotificationsEnabledKey = "high-signal-notifications-enabled"

/** Whether or not the user has enabled high-signal notifications */
export function getNotificationsEnabled() {
  return getBoolean(NotificationsEnabledKey, true)
}
