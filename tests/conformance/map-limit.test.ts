// 自有回归：待办页对列表里的每个仓库问摘要，并发要封顶（2026-10-30 几百个仓库一起跑完整 status 把 CPU 打满）。
import { expect, test } from "bun:test"

import { mapLimit } from "../../src/lib/map-limit"

test("同时在跑的条目数不超过上限，且每个条目都跑到", async () => {
  let running = 0
  let peak = 0
  const done: number[] = []
  const items = Array.from({ length: 23 }, (_, i) => i)
  await mapLimit(items, 4, async item => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise(resolve => setTimeout(resolve, item % 3))
    running -= 1
    done.push(item)
  })
  expect(peak).toBe(4)
  expect(running).toBe(0)
  expect(done.toSorted((a, b) => a - b)).toEqual(items)
})

test("空列表立即完成，上限大于条目数时不多开", async () => {
  let calls = 0
  await mapLimit([], 4, async () => {
    calls += 1
  })
  expect(calls).toBe(0)
  let running = 0
  let peak = 0
  await mapLimit([1, 2], 8, async () => {
    running += 1
    peak = Math.max(peak, running)
    await Promise.resolve()
    running -= 1
  })
  expect(peak).toBe(2)
})

test("一个条目出错整体 reject，和 Promise.all 一样", async () => {
  await expect(
    mapLimit([1, 2, 3], 2, async item => {
      if (item === 2) throw new Error("boom")
    })
  ).rejects.toThrow("boom")
})
