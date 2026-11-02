// Original Node environment boundary. Desktop's __DEV__ / __RELEASE_CHANNEL__ are
// webpack constants that the original suites reassign on globalThis; mirror those
// assignments into the live bindings so feature flags observe them, as upstream does.
declare global {
  var __DEV__: boolean
  var __RELEASE_CHANNEL__: string
}
export let development = Boolean(globalThis.__DEV__)
export let releaseChannel: string = globalThis.__RELEASE_CHANNEL__ ?? "production"
export const previewFeatures = () => process.env.GITHUB_DESKTOP_PREVIEW_FEATURES

const mirrors: Record<string, (value: unknown) => void> = {
  __DEV__: value => {
    development = Boolean(value)
  },
  __RELEASE_CHANNEL__: value => {
    releaseChannel = String(value)
  }
}
for (const [name, mirror] of Object.entries(mirrors)) {
  let value: unknown = (globalThis as Record<string, unknown>)[name]
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: next => {
      value = next
      mirror(next)
    }
  })
}
