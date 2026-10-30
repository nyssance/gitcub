import assert from "node:assert/strict"
import { it } from "node:test"

import { createCoalescingRunner } from "../../src/lib/coalescing-runner"

it("serializes a burst and reads changes made during the first scan in one trailing scan", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const values: number[] = []
  let value = 1
  const refresh = createCoalescingRunner(async () => {
    values.push(value)
    if (values.length === 1) {
      entered.resolve()
      await release.promise
    }
  })
  const first = refresh()
  await entered.promise
  value = 2
  const trailing = Array.from({ length: 100 }, refresh)
  assert.deepEqual(values, [1])
  assert.ok(trailing.every(result => result === trailing[0]))
  release.resolve()
  await Promise.all([first, ...trailing])
  assert.deepEqual(values, [1, 2])
  value = 3
  await refresh()
  assert.deepEqual(values, [1, 2, 3])
})

it("a failed scan rejects its callers without dropping the queued refresh", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const refresh = createCoalescingRunner(async () => {
    if (++calls === 1) {
      entered.resolve()
      await release.promise
      throw new Error("scan failed")
    }
  })
  const first = refresh()
  const rejected = assert.rejects(first, /scan failed/)
  await entered.promise
  const trailing = refresh()
  release.resolve()
  await Promise.all([rejected, trailing])
  assert.equal(calls, 2)
})

it("changes during a trailing scan schedule another scan without overlap", async () => {
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let calls = 0
  const refresh = createCoalescingRunner(async () => {
    const index = calls++
    entered[index]?.resolve()
    await release[index]?.promise
  })
  const first = refresh()
  await entered[0].promise
  const second = refresh()
  release[0].resolve()
  await entered[1].promise
  const third = refresh()
  assert.equal(calls, 2)
  release[1].resolve()
  await Promise.all([first, second, third])
  assert.equal(calls, 3)
})

it("an unrelated repository can refresh while another repository is scanning", async () => {
  const release = Promise.withResolvers<void>()
  const oldRepository = createCoalescingRunner(() => release.promise)
  let read = false
  const newRepository = createCoalescingRunner(async () => {
    read = true
  })
  const old = oldRepository()
  await newRepository()
  assert.equal(read, true)
  release.resolve()
  await old
})

it("cancels the active wait and queued scan without waiting for native work", async () => {
  const entered = Promise.withResolvers<void>()
  const native = Promise.withResolvers<void>()
  let calls = 0
  let delivered = false
  const refresh = createCoalescingRunner(async signal => {
    calls++
    entered.resolve()
    await native.promise
    if (!signal.aborted) delivered = true
  })
  const first = refresh()
  await entered.promise
  const trailing = refresh()
  refresh.cancel()
  await Promise.all([first, trailing])
  assert.equal(calls, 1)
  native.resolve()
  await Promise.resolve()
  assert.equal(delivered, false)
})

it("a fresh generation survives settlement of a cancelled generation", async () => {
  const entered = Promise.withResolvers<void>()
  const oldNative = Promise.withResolvers<void>()
  let calls = 0
  const refresh = createCoalescingRunner(async () => {
    if (++calls === 1) {
      entered.resolve()
      await oldNative.promise
    }
  })
  const old = refresh()
  await entered.promise
  const oldTrailing = refresh()
  refresh.cancel()
  const fresh = refresh()
  const freshTrailing = refresh()
  await Promise.all([old, oldTrailing, fresh, freshTrailing])
  assert.equal(calls, 3)
  oldNative.reject(new Error("late native failure"))
  await Promise.resolve()
  await refresh()
  assert.equal(calls, 4)
})
