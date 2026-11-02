import { Effect } from "effect"

import type { DeviceStart, PollStatus } from "../models/app-state"

/** RFC 8628 polling shared by every account entry point. */
export async function pollDeviceAuthorization(
  start: Pick<DeviceStart, "interval" | "expiresIn">,
  poll: () => Promise<PollStatus>,
  signal: AbortSignal,
  now = Date.now,
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
): Promise<"done" | "denied" | "expired"> {
  signal.throwIfAborted()
  const polling = Effect.gen(function* () {
    let interval = Math.max(1, start.interval) * 1000
    const deadline = now() + start.expiresIn * 1000
    while (now() < deadline) {
      const delay = Math.min(interval, deadline - now())
      yield* wait
        ? Effect.tryPromise({ try: innerSignal => wait(delay, innerSignal), catch: error => error })
        : Effect.sleep(delay)
      signal.throwIfAborted()
      if (now() >= deadline) break
      const result = yield* Effect.tryPromise({ try: poll, catch: error => error })
      signal.throwIfAborted()
      if (result === "slowDown") interval += 5000
      else if (result !== "pending") return result
    }
    return "expired" as const
  })
  try {
    return await Effect.runPromise(polling, { signal })
  } catch (error) {
    signal.throwIfAborted()
    throw error
  }
}
