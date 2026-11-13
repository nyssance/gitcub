// 点选文件时立刻发出 diff 请求，随后 effect 以同样参数调用 loadDiff 时接管，不重复请求。
import { beforeEach, expect, test } from "bun:test"

import { useChangesStore } from "../../src/features/changes/store"
import type { RepoStatus } from "../../src/models/repo-status"

const calls: string[] = []
const text = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"
// 测试入口的 invoke 替身优先用这里给的命令实现，不落到真实 Git
Object.assign(globalThis, {
  __gitcubNativeFixtures: (command: string, args: { file: string }) => {
    if (command !== "working_directory_diff") throw new Error(command)
    calls.push(args.file)
    return { text: text.replaceAll("a.txt", args.file), lineEndings: null }
  }
})

const changes = [] as unknown as RepoStatus["changes"]
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

beforeEach(async () => {
  await settle()
  useChangesStore.getState().reset()
  calls.length = 0
})

test("点选即发请求，loadDiff 以同样参数接管，只请求一次", async () => {
  const store = useChangesStore.getState()
  store.selectFile("/repo", "a.txt", changes, 1)
  expect(useChangesStore.getState().selected).toBe("a.txt")
  store.loadDiff("/repo", "a.txt", changes, 1)
  await settle()
  expect(calls).toEqual(["a.txt"])
  expect(useChangesStore.getState().diff?.hunks.length).toBe(1)
})

test("接管只有一次：同样参数的下一次 loadDiff 重新请求", async () => {
  const store = useChangesStore.getState()
  store.selectFile("/repo", "a.txt", changes, 1)
  store.loadDiff("/repo", "a.txt", changes, 1)
  store.loadDiff("/repo", "a.txt", changes, 1)
  await settle()
  expect(calls).toEqual(["a.txt", "a.txt"])
})

test("参数对不上（监听刷新了一轮）时不接管，改按新参数请求", async () => {
  const store = useChangesStore.getState()
  store.selectFile("/repo", "a.txt", changes, 1)
  store.loadDiff("/repo", "a.txt", changes, 2)
  await settle()
  expect(calls).toEqual(["a.txt", "a.txt"])
})

test("连点两个文件：前一个的结果不落到后一个上", async () => {
  const store = useChangesStore.getState()
  store.selectFile("/repo", "a.txt", changes, 1)
  store.selectFile("/repo", "b.txt", changes, 1)
  const cancel = store.loadDiff("/repo", "b.txt", changes, 1)
  await settle()
  expect(useChangesStore.getState().selected).toBe("b.txt")
  expect([...useChangesStore.getState().files.keys()]).toEqual(["b.txt"])
  cancel()
})

test("effect 清理时取消被接管的请求，结果不再写入", async () => {
  const store = useChangesStore.getState()
  store.selectFile("/repo", "a.txt", changes, 1)
  store.loadDiff("/repo", "a.txt", changes, 1)()
  await settle()
  expect(useChangesStore.getState().diff).toBeNull()
})
