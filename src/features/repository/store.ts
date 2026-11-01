/**
 * Repository Store —— 当前仓库的实时状态：工作区状态、贮藏、LFS、issue 补全、提交身份，以及所有 Git 写操作共用的互斥入口。
 *
 * 刷新：同一时间只跑一次扫描，扫描期间又来的请求合并成一次尾随刷新（createCoalescingRunner）。
 * 换仓库时 bind 的清理函数取消整个刷新，进行中的 fiber 被中断，旧仓库的结果不会写进来。
 *
 * 写操作：run() 持有唯一的操作锁；锁被占时直接放弃，不排队（Desktop 同样在操作进行中禁用入口）。
 * 失败按错误类型给出文案，结束后总是刷新一次。确认后的恢复动作在同一个 run 里完成，不会再去抢这把锁。
 */
import equal from "deep-equal"
import { Effect } from "effect"
import { create } from "zustand"

import { useAccountsStore } from "@/features/accounts/store"
import { activeRepository } from "@/features/app-state/store"
import {
  attempt,
  call,
  describeError,
  forkCancelable,
  resolve,
  runPromise,
  type Updater
} from "@/features/effect-runtime"
import { createCoalescingRunner } from "@/lib/coalescing-runner"
import type { IMentionableUser } from "@/lib/databases/github-user-database"
import { contributionRepository } from "@/lib/fork-contribution"
import type { Issue, LfsState, Remote, StashEntry } from "@/models/app-state"
import type { RepoStatus } from "@/models/repo-status"

export const EMPTY_STATUS: RepoStatus = {
  branch: null,
  changes: [],
  remote: null,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  operation: null,
  theirs: null
}

interface RepositoryStore {
  status: RepoStatus
  stashList: StashEntry[]
  /** 用了 LFS 但过滤器没生效时，检出的大文件全是指针；直接提交会把指针当内容盖上去 */
  lfs: LfsState | null
  /** 写提交信息时 `#` 能补全的 issue 号；没远端或没登录时为空 */
  issues: Issue[]
  /** 提交信息 `@` 补全与共同作者候选 */
  mentionables: IMentionableUser[]
  author: { name: string; email: string } | undefined
  /** 每次刷新加一：提交图、文件历史、LFS 跟着重新查询 */
  reloadKey: number
  /** 状态返回后加一：选中文件的 diff 跟着刷新后的状态取（Desktop 在 loadStatus 之后才重新加载 diff） */
  diffKey: number
  error: string | null
  busy: boolean
  progress: string
  refresh: () => Promise<void>
  /** 换仓库时调用；返回的函数取消这个仓库的刷新。 */
  bind: (repo: string | null) => () => void
  /** 换仓库时清掉上一个仓库的状态。 */
  reset: () => void
  run: <T>(operation: () => Promise<T>) => Promise<T | undefined>
  /** Desktop FetchType.BackgroundTask：同一把操作锁，忙时跳过；失败只记日志，不清掉也不覆盖界面上的错误。 */
  runBackground: (operation: () => Promise<unknown>) => Promise<void>
  setError: (error: string | null) => void
  showProgress: (text: string) => void
  setLfs: (lfs: LfsState | null) => void
  setAuthor: (author: { name: string; email: string }) => void
  setStatus: (next: Updater<RepoStatus>) => void
  /** Desktop buildAutocompletionProviders：Issue 与用户都取贡献目标（fork 为上游贡献时是上游） */
  loadCompletions: (repo: string | null, remote: Remote | null | undefined) => () => void
  loadAuthor: () => void
}

let locked = false

const refreshRepository = (repo: string | null) =>
  Effect.gen(function* () {
    if (repo !== activeRepository()) return
    const { getState, setState } = useRepositoryStore
    setState(store => ({ reloadKey: store.reloadKey + 1 }))
    if (!repo) {
      setState({ status: EMPTY_STATUS, lfs: null })
      return
    }
    const [next, remote] = yield* Effect.all(
      [call("repoStatus", ipc => ipc.repoStatus(repo)), call("repoRemote", ipc => ipc.repoRemote(repo))],
      { concurrency: 2 }
    )
    if (repo !== activeRepository()) return
    useAccountsStore.getState().setRemote(repo, remote)
    // 文件监听在构建这类场景下会反复触发刷新；内容没变就不换对象，改动列表不白重绘
    if (!equal(getState().status, next)) setState({ status: next })
    setState(store => ({ diffKey: store.diffKey + 1 }))
    // LFS 规则只可能来自 .gitattributes 等文件：同一次刷新里接着查，未跟踪的那些直接用这份 status，
    // 后端不必再遍历工作区；与 status 串行，不和它抢磁盘。查不到只当没用 LFS，不报错
    const untracked = next.changes.filter(change => change.kind === "untracked").map(change => change.path)
    const lfs = yield* call("lfsState", ipc => ipc.lfsState(repo, untracked)).pipe(
      Effect.catch(() => Effect.succeed(null))
    )
    if (repo !== activeRepository()) return
    if (!equal(getState().lfs, lfs)) setState({ lfs })
    const stashes = yield* call("stashes", ipc => ipc.stashes(repo))
    if (repo !== activeRepository()) return
    if (!equal(getState().stashList, stashes)) setState({ stashList: stashes })
  }).pipe(
    Effect.catch(error =>
      Effect.sync(() => {
        if (repo === activeRepository()) useRepositoryStore.setState({ error: describeError(error) })
      })
    )
  )

export const useRepositoryStore = create<RepositoryStore>()((set, get) => ({
  status: EMPTY_STATUS,
  stashList: [],
  lfs: null,
  issues: [],
  mentionables: [],
  author: undefined,
  reloadKey: 0,
  diffKey: 0,
  error: null,
  busy: false,
  progress: "",
  refresh: () => Promise.resolve(),
  bind: repo => {
    const runner = createCoalescingRunner(signal => runPromise(refreshRepository(repo), { signal }))
    set({ refresh: runner })
    void runner()
    return () => runner.cancel()
  },
  reset: () => set({ status: EMPTY_STATUS, stashList: [], lfs: null, error: null }),
  run: operation => {
    if (locked || get().busy) return Promise.resolve(undefined)
    const repo = activeRepository()
    locked = true
    set({ busy: true, error: null })
    return runPromise(
      attempt(operation).pipe(
        Effect.catch(error =>
          Effect.sync(() => {
            if (repo === activeRepository()) set({ error: describeError(error) })
            return undefined
          })
        ),
        Effect.ensuring(
          Effect.promise(() =>
            get()
              .refresh()
              .catch(error => set({ error: String(error) }))
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                locked = false
                set({ busy: false, progress: "" })
              })
            )
          )
        )
      )
    )
  },
  runBackground: operation => {
    if (locked || get().busy) return Promise.resolve()
    locked = true
    set({ busy: true })
    return runPromise(
      attempt(operation).pipe(
        Effect.catch(error => Effect.sync(() => log.warn("Background fetch failed", describeError(error)))),
        Effect.ensuring(
          Effect.promise(() =>
            get()
              .refresh()
              .catch(error => log.warn("Refresh after background fetch failed", String(error)))
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                locked = false
                set({ busy: false, progress: "" })
              })
            )
          )
        )
      )
    ).then(() => undefined)
  },
  setError: error => set({ error }),
  showProgress: text => set({ progress: text.split(/[\r\n]/).findLast(Boolean) ?? "" }),
  setLfs: lfs => set({ lfs }),
  setAuthor: author => set({ author }),
  setStatus: next => set(store => ({ status: resolve(next, store.status) })),

  // 取不到（没远端/没登录）就是空的，补全什么都不弹，不该因为这个跳错误
  loadCompletions: (repo, remote) => {
    set({ issues: [], mentionables: [] })
    if (!repo || !remote) return () => {}
    return forkCancelable(
      Effect.gen(function* () {
        const target = yield* call("contributionRepository", () => contributionRepository(repo, remote))
        // 两样各自失败各自空：Issue 取不到不该连带 @ 补全也没有
        yield* Effect.all(
          [
            call("issuesForCompletion", ipc => ipc.issuesForCompletion(target.host, target.owner, target.name)).pipe(
              Effect.match({ onFailure: () => set({ issues: [] }), onSuccess: issues => set({ issues }) })
            ),
            call("mentionables", ipc => ipc.mentionables(target.host, target.owner, target.name)).pipe(
              Effect.match({
                onFailure: () => set({ mentionables: [] }),
                onSuccess: mentionables => set({ mentionables })
              })
            )
          ],
          { concurrency: "unbounded" }
        )
      }).pipe(Effect.catch(() => Effect.void))
    )
  },
  loadAuthor: () => {
    forkCancelable(
      call("gitIdentity", ipc => ipc.gitIdentity()).pipe(
        Effect.match({
          onFailure: () => set({ author: { name: "", email: "" } }),
          onSuccess: author => set({ author })
        })
      )
    )
  }
}))
