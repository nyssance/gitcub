/** Inclusive revision range, matching Desktop rev-list semantics. */
export function revRangeInclusive(from: string, to: string) {
  return `${from}^..${to}`
}
