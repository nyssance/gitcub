import { createStatsPost, StatsStore as ProductionStore } from "../../src/lib/stats/stats-store"
export * from "../../src/lib/stats/stats-store"
export class StatsStore extends ProductionStore {
  constructor(
    db: ConstructorParameters<typeof ProductionStore>[0],
    monitor: ConstructorParameters<typeof ProductionStore>[1],
    post = createStatsPost({
      current: "https://cafe.github.com/twirp/clientappsfe.observability.v1.TelemetryAPI/RecordEvents",
      legacy: "https://central.github.com/api/usage/desktop"
    })
  ) {
    super(db, monitor, post)
  }
}
