import { configure } from "@testing-library/react"

// RTL 16 drains microtasks with setTimeout(0), while Desktop's RTL 12 did
// not. Keep Node's fake clock for application timers, but use the real clock
// for this harness-only drain so an awaited waitFor cannot deadlock it.
const drain = globalThis.setTimeout
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actGlobal.IS_REACT_ACT_ENVIRONMENT = true
configure({
  asyncWrapper: async callback => {
    const previous = actGlobal.IS_REACT_ACT_ENVIRONMENT
    actGlobal.IS_REACT_ACT_ENVIRONMENT = false
    try {
      const result = await callback()
      await new Promise<void>(resolve => drain(resolve, 0))
      return result
    } finally {
      actGlobal.IS_REACT_ACT_ENVIRONMENT = previous
    }
  }
})
