/**
 * Desktop getShasInDiff：多选提交时这份 diff 实际包含哪些提交。
 *
 * 从最新的那个沿父提交走，只走选中的；走不到的（合并带进来的另一条线上、在列表里正好夹在中间的提交）
 * 不在 diff 里。`selectedShas` 按列表顺序，第一个是最新的。
 */
export function shasInDiff(
  selectedShas: ReadonlyArray<string>,
  commitLookup: ReadonlyMap<string, { readonly parentSHAs: ReadonlyArray<string> }>
): string[] {
  const latest = selectedShas[0]
  if (latest === undefined) return []
  const selected = new Set(selectedShas)
  const inDiff = new Set<string>()
  const pending = [latest]
  for (let sha = pending.pop(); sha !== undefined; sha = pending.pop()) {
    if (inDiff.has(sha)) continue
    inDiff.add(sha)
    for (const parent of commitLookup.get(sha)?.parentSHAs ?? [])
      if (selected.has(parent) && !inDiff.has(parent)) pending.push(parent)
  }
  return [...inDiff]
}
