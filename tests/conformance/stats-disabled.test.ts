import assert from "node:assert/strict"
import { it, mock } from "node:test"

import { Disposable } from "event-kit"

import { StatsDatabase, StatsStore } from "../../src/lib/stats"

it("without a metrics transport, reporting preserves pending data and delivery markers", async () => {
  localStorage.removeItem("has-sent-stats-opt-in-ping")
  localStorage.removeItem("last-daily-stats-report")
  const db = new StatsDatabase("gitcub-disabled-stats")
  const errors = mock.method(log, "error")
  try {
    const store = new StatsStore(db, { onActivity: () => new Disposable() }, null)
    const clear = mock.method(store, "clearDailyStats", async () => {})
    await store.setOptOut(false, true)
    assert.equal(await store.sendStats([], []), false)
    await store.reportStats([], [])
    assert.equal(clear.mock.callCount(), 0)
    assert.equal(localStorage.getItem("has-sent-stats-opt-in-ping"), null)
    assert.equal(localStorage.getItem("last-daily-stats-report"), null)
    assert.equal(errors.mock.callCount(), 0)
  } finally {
    mock.restoreAll()
    db.close()
    localStorage.removeItem("stats-opt-out")
  }
})
