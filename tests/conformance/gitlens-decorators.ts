// Stand-ins for `@gitlens/utils/decorators/{log,memoize,serializable}.js` on the GitStatus/GitStatusFile
// snapshots. The ported suite reads the model getters directly, so loggable names, memoized getter caches and
// toJSON materialization are left out rather than pulling in the GitLens logger.
export function loggable<T>(_name?: (instance: T) => string) {
  return (_target: unknown): void => {}
}

export function memoize(_options?: unknown) {
  return (_target: unknown, _key: string, _descriptor: PropertyDescriptor): void => {}
}

export function serializable(_target: unknown): void {}
