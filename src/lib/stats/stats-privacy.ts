import { getBoolean } from "../../upstream/lib/local-storage"

const StatsOptOutKey = "stats-opt-out"
export function getHasOptedOutOfStats() {
  return getBoolean(StatsOptOutKey)
}
