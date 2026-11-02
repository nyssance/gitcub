import { Effect } from "effect"

export interface CoalescingRunner {
  (): Promise<void>
  /** Cancel this generation, including its trailing scan. Future calls start fresh. */
  cancel(): void
}

/** Serialize refreshes, retaining one trailing run for changes during a scan.
 * Cancellation interrupts the wait; native operations still own their process lifetime. */
export function createCoalescingRunner(run: (signal: AbortSignal) => Promise<void>): CoalescingRunner {
  let active: Promise<void> | undefined
  let queued: Promise<void> | undefined
  let controller: AbortController | undefined
  let generation = 0

  const start = (): Promise<void> => {
    const attempt = new AbortController()
    controller = attempt
    const result = Effect.runPromise(Effect.tryPromise({ try: run, catch: error => error }), {
      signal: attempt.signal
    }).catch(error => {
      if (!attempt.signal.aborted) throw error
    })
    active = result
    const clear = () => {
      if (active === result) {
        active = undefined
        controller = undefined
      }
    }
    void result.then(clear, clear)
    return result
  }

  const refresh = () => {
    if (queued) return queued
    if (!active) return start()
    const current = generation
    const next = () => {
      if (current !== generation) return
      queued = undefined
      return start()
    }
    queued = active.then(next, next)
    return queued
  }
  refresh.cancel = () => {
    generation++
    controller?.abort()
    controller = undefined
    active = undefined
    queued = undefined
  }
  return refresh
}
