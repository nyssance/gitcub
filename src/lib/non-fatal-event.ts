export function emitNonFatalException(_event: "send-non-fatal-exception", error: Error, context: { kind: string }) {
  window.dispatchEvent(new CustomEvent("gitcub-non-fatal-exception", { detail: { error, context } }))
  log.error(`Non-fatal exception (${context.kind})`, error)
}
