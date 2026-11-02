import type { IDailyMeasures } from "./stats-database"
export type NumericMeasures = {
  [P in keyof IDailyMeasures as IDailyMeasures[P] extends number ? P : never]: IDailyMeasures[P]
}
export interface IStatsStore {
  increment: (k: keyof NumericMeasures, n?: number) => Promise<void>
}
