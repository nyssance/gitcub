// Desktop MIT port; platform imports adapted to Tauri.
/**
 * An action being computed in the background on behalf of the user
 */
export const ComputedAction = {
  Loading: "loading",
  Clean: "clean",
  Conflicts: "conflicts",
  Invalid: "invalid"
} as const
export type ComputedAction = (typeof ComputedAction)[keyof typeof ComputedAction]
