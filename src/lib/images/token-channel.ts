import { installAuthenticatedImageTokenHandler } from "./authenticated-image-token-handler"
import { createAuthenticatedImageTokenResolver } from "./authenticated-image-token-resolver"
import type { ImageTokenListener, WebContents } from "./transport-contract"
import { addTrustedIPCSender } from "./trusted-ipc-sender"

let nextEndpointId = 1
/** Private ports keep token responses out of global window events and unrelated webviews. */
export function createImageTokenChannel(resolveToken: (endpoint: string, token: string) => Promise<string>) {
  const { port1, port2 } = new MessageChannel()
  let destroyed = false
  const onDestroyed = new Set<() => void>()
  const listeners = new Set<ImageTokenListener>()
  const endpoint: WebContents = {
    id: nextEndpointId++,
    isDestroyed: () => destroyed,
    send: (_channel, requestId, endpoint, token) => port1.postMessage({ requestId, endpoint, token }),
    on: (_event, callback) => {
      onDestroyed.add(callback)
    }
  }
  addTrustedIPCSender(endpoint)
  const resolver = createAuthenticatedImageTokenResolver(() => (destroyed ? undefined : endpoint))
  const disposeHandler = installAuthenticatedImageTokenHandler(resolveToken, {
    on: (_channel, listener) => listeners.add(listener),
    removeListener: (_channel, listener) => listeners.delete(listener),
    send: (_channel, requestId, token) => port2.postMessage({ requestId, token })
  })
  port2.onmessage = event => {
    const { requestId, endpoint, token } = event.data
    if (!Number.isSafeInteger(requestId) || typeof endpoint !== "string" || typeof token !== "string") return
    for (const listener of listeners) listener(event, requestId, endpoint, token)
  }
  port1.onmessage = event => {
    const { requestId, token } = event.data
    if (!Number.isSafeInteger(requestId) || (token !== null && typeof token !== "string")) return
    resolver.acceptResponse(endpoint, requestId, token)
  }
  return {
    resolveToken: resolver.resolveToken,
    updateAccounts: resolver.updateAccounts,
    dispose: () => {
      if (destroyed) return
      destroyed = true
      disposeHandler()
      resolver.updateAccounts([])
      port1.close()
      port2.close()
      for (const callback of onDestroyed) callback()
      onDestroyed.clear()
    }
  }
}
