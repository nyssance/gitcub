import assert from "node:assert/strict"
import { it } from "node:test"

import { pollDeviceAuthorization } from "../../src/lib/device-authorization"
import type { PollStatus } from "../../src/models/app-state"

it("honors slow_down and the expiry deadline", async () => {
  let time = 0
  const waits: number[] = []
  let calls = 0
  const outcome = await pollDeviceAuthorization(
    { interval: 2, expiresIn: 10 },
    async () => {
      calls++
      return "slowDown"
    },
    new AbortController().signal,
    () => time,
    async delay => {
      waits.push(delay)
      time += delay
    }
  )
  assert.equal(outcome, "expired")
  assert.deepEqual(waits, [2000, 7000, 1000])
  assert.equal(calls, 2)
})
it("closing sign-in prevents another poll", async () => {
  const attempt = new AbortController()
  let calls = 0
  await assert.rejects(
    pollDeviceAuthorization(
      { interval: 1, expiresIn: 60 },
      async () => {
        calls++
        return "done"
      },
      attempt.signal,
      () => 0,
      async () => {
        attempt.abort()
      }
    ),
    { name: "AbortError" }
  )
  assert.equal(calls, 0)
})
it("a cancelled in-flight response cannot report successful sign-in", async () => {
  const attempt = new AbortController()
  await assert.rejects(
    pollDeviceAuthorization(
      { interval: 1, expiresIn: 60 },
      async () => {
        attempt.abort()
        return "done"
      },
      attempt.signal,
      () => 0,
      async () => {}
    ),
    { name: "AbortError" }
  )
})

it("cancellation settles even if an in-flight native poll never responds", async () => {
  const attempt = new AbortController()
  const entered = Promise.withResolvers<void>()
  const native = Promise.withResolvers<PollStatus>()
  const result = pollDeviceAuthorization(
    { interval: 1, expiresIn: 60 },
    () => {
      entered.resolve()
      return native.promise
    },
    attempt.signal,
    () => 0,
    async () => {}
  )
  const rejected = assert.rejects(result, { name: "AbortError" })
  await entered.promise
  attempt.abort()
  await rejected
  native.resolve("done")
})

it("already cancelled sign-in performs no work", async () => {
  const attempt = new AbortController()
  attempt.abort()
  await assert.rejects(
    pollDeviceAuthorization(
      { interval: 1, expiresIn: 60 },
      async () => {
        assert.fail("must not poll")
      },
      attempt.signal
    ),
    { name: "AbortError" }
  )
})
