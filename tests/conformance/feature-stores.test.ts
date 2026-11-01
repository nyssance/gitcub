// 自有回归：App 的状态拆进 features/*/store.ts（2026-10-30）。这里锁住替换掉会话计数器和 ref 标志位的那几条语义。
import { expect, test } from "bun:test"

import { Effect } from "effect"

import { useDialogsStore } from "../../src/features/dialogs/store"
import { call, createTaskGroup, GitIpc, IpcError, runPromise } from "../../src/features/effect-runtime"
import { useRepositoryStore } from "../../src/features/repository/store"
import { BranchWorkflowError } from "../../src/lib/branch-workflows"
import { GitError } from "../../src/lib/git-error"

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

test("任务组中断后，还在路上的请求不再写状态", async () => {
  const group = createTaskGroup()
  const writes: string[] = []
  group.fork(Effect.sleep(20).pipe(Effect.andThen(Effect.sync(() => writes.push("stale")))))
  group.interrupt()
  group.fork(Effect.sync(() => writes.push("fresh")))
  await tick(40)
  expect(writes).toEqual(["fresh"])
})

test("后端调用失败成为带命令名的 IpcError，服务从上下文注入", async () => {
  const failing = Effect.provideService(
    call("repoStatus", client => client.repoStatus("/r")),
    GitIpc,
    { repoStatus: () => Promise.reject(new Error("fatal: not a git repository")) } as never
  )
  const exit = await Effect.runPromise(Effect.flip(failing))
  expect(exit).toBeInstanceOf(IpcError)
  expect(exit.command).toBe("repoStatus")
  expect(exit.message).toContain("not a git repository")
  expect(await runPromise(Effect.succeed(1))).toBe(1)
})

test("操作锁被占时第二个操作直接放弃，结束后复位忙状态", async () => {
  const store = useRepositoryStore.getState()
  let release!: () => void
  const first = store.run(() => new Promise<string>(resolve => (release = () => resolve("done"))))
  expect(useRepositoryStore.getState().busy).toBe(true)
  let ran = false
  expect(
    await store.run(async () => {
      ran = true
    })
  ).toBeUndefined()
  expect(ran).toBe(false)
  release()
  expect(await first).toBe("done")
  expect(useRepositoryStore.getState().busy).toBe(false)
  expect(useRepositoryStore.getState().progress).toBe("")
})

test("操作失败进错误对话框队列（Desktop performFailableOperation → emitError）：分支工作流错误走 workflow 文案，git 输出成 GitError", async () => {
  const store = useRepositoryStore.getState()
  useDialogsStore.setState({ errors: [] })
  await store.run(() => Promise.reject(new BranchWorkflowError("noRemotes")))
  await store.run(() => Promise.reject(new Error("fatal: boom")))
  await store.run(async () => {})
  const [workflow, git] = useDialogsStore.getState().errors
  expect(useDialogsStore.getState().errors).toHaveLength(2)
  expect(workflow?.message).toBe("The repository has no remotes.")
  expect(git).toBeInstanceOf(GitError)
  expect(git?.message).toBe("fatal: boom")
  expect(useRepositoryStore.getState().error).toBeNull()
  useDialogsStore.getState().clearError(workflow!)
  expect(useDialogsStore.getState().errors).toEqual([git])
})

test("确认框与填字框把答案交回调用方并关闭", async () => {
  const dialogs = useDialogsStore.getState()
  const ok = dialogs.ask("force push?")
  expect(useDialogsStore.getState().asking?.message).toBe("force push?")
  useDialogsStore.getState().answer(true)
  expect(await ok).toBe(true)
  expect(useDialogsStore.getState().asking).toBeNull()
  const name = dialogs.askText("tag name", "v1")
  useDialogsStore.getState().setAskingTextValue("v2")
  useDialogsStore.getState().answerText(useDialogsStore.getState().askingText?.value ?? null)
  expect(await name).toBe("v2")
})
