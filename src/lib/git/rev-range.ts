// Desktop MIT implementation extracted unchanged from lib/git/rev-list.ts.
export function revRange(from: string, to: string) {
  return `${from}..${to}`
}

/**
 * Convert two refs into the Git range syntax representing the set of commits
 * that are reachable from `to` but excluding those that are reachable from
 * `from`. However as opposed to `revRange`, this will also include `from` ref.
 *
 * Each parameter can be the commit SHA or a ref name, or specify an empty
 * string to represent HEAD.
 *
 * @param from The start of the range
 * @param to The end of the range
 */
export function revRangeInclusive(from: string, to: string) {
  return `${from}^..${to}`
}

/**
 * Convert two refs into the Git symmetric difference syntax, which represents
 * the set of commits that are reachable from either `from` or `to` but not
 * from both.
 *
 * Each parameter can be the commit SHA or a ref name, or you can use an empty
 * string to represent HEAD.
 *
 * @param from The start of the range
 * @param to The end of the range
 */
export function revSymmetricDifference(from: string, to: string) {
  return `${from}...${to}`
}
