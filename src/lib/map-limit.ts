/** 按固定并发跑完所有条目，顺序取、谁先空谁接下一个。
 *
 * 每个条目的错误由 `run` 自己处理：一个条目 reject 整体就 reject，和 Promise.all 一样。 */
export async function mapLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next] as T
      next += 1
      await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}
