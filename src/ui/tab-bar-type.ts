// Desktop MIT port; platform imports adapted to Tauri.
/** The tab bar type. */
export const TabBarType = {
  Tabs: 0,
  Switch: 1,
  Vertical: 2
} as const
export type TabBarType = (typeof TabBarType)[keyof typeof TabBarType]
