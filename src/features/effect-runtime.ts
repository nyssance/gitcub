import { Context, Effect, type Fiber, Schema } from "effect"

import { BranchWorkflowError } from "@/lib/branch-workflows"
import i18n from "@/lib/i18n"
import { ipc } from "@/lib/ipc"

/** 后端命令集合作为服务注入：store 里的流程只声明依赖它，运行时才提供实现，测试可换成假的。 */
export class GitIpc extends Context.Service<GitIpc, typeof ipc>()("GitCub/GitIpc") {}

/** 一次后端调用失败。message 是后端原样返回的错误文本，界面直接显示它。 */
export class IpcError extends Schema.TaggedError<IpcError>()("IpcError", {
  command: Schema.String,
  message: Schema.String
}) {}

/** 分支工作流的业务错误（没有远端、分支不存在……），按 code 走 workflow.* 文案。 */
export class WorkflowError extends Schema.TaggedError<WorkflowError>()("WorkflowError", { code: Schema.String }) {}

/** 操作回调里抛出的其它错误。 */
export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  message: Schema.String
}) {}

export type AppError = IpcError | WorkflowError | OperationError

/** 调一个后端命令。 */
export const call = Effect.fnUntraced(function* <A>(
  command: string,
  invoke: (client: typeof ipc) => Promise<A>
): Effect.fn.Return<A, IpcError, GitIpc> {
  const client = yield* GitIpc
  return yield* Effect.tryPromise({
    try: () => invoke(client),
    catch: error => new IpcError({ command, message: String(error) })
  })
})

/** 包一段已有的 Promise 流程（分支工作流、暂存选择）：BranchWorkflowError 保留成业务错误。 */
export const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, WorkflowError | OperationError> =>
  Effect.tryPromise({
    try: run,
    catch: error =>
      error instanceof BranchWorkflowError
        ? new WorkflowError({ code: error.code })
        : new OperationError({ message: String(error) })
  })

/** 错误槽里显示的文字。 */
export function describeError(error: AppError): string {
  switch (error._tag) {
    case "WorkflowError":
      return i18n.t(`workflow.${error.code}`)
    case "IpcError":
    case "OperationError":
      return error.message
  }
}

const provide = <A, E>(effect: Effect.Effect<A, E, GitIpc>) => Effect.provideService(effect, GitIpc, ipc)

export const runPromise = <A, E>(effect: Effect.Effect<A, E, GitIpc>, options?: { signal?: AbortSignal }) =>
  Effect.runPromise(provide(effect), options)

export const runFork = <A, E>(effect: Effect.Effect<A, E, GitIpc>) => Effect.runFork(provide(effect))

/** 一组同属一次加载的请求。换仓库、换文件或从头重载时整组中断：
 *  被中断的 fiber 不会再执行后面的状态写入，过期结果因此不会覆盖新状态，不需要会话计数器。 */
export interface TaskGroup {
  fork<A, E>(effect: Effect.Effect<A, E, GitIpc>): void
  interrupt(): void
}

export function createTaskGroup(): TaskGroup {
  const fibers = new Set<Fiber.Fiber<unknown, unknown>>()
  return {
    fork(effect) {
      const fiber = runFork(effect)
      fibers.add(fiber)
      fiber.addObserver(() => fibers.delete(fiber))
    },
    interrupt() {
      for (const fiber of fibers) fiber.interruptUnsafe()
      fibers.clear()
    }
  }
}

/** 允许传值或更新函数的 setter，和 React setState 同形，组件里的调用点不用改。 */
export type Updater<T> = T | ((previous: T) => T)
export const resolve = <T>(next: Updater<T>, previous: T): T =>
  typeof next === "function" ? (next as (previous: T) => T)(previous) : next

/** 起一个 fiber，返回中断它的函数，正好当 useEffect 的清理函数。 */
export function forkCancelable<A, E>(effect: Effect.Effect<A, E, GitIpc>): () => void {
  const fiber = runFork(effect)
  return () => fiber.interruptUnsafe()
}
