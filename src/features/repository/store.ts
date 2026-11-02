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
import { useDialogsStore } from "@/features/dialogs/store"
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
import { toPresentableError } from "@/lib/presentable-error"
import type { Issue, LfsState, Remote, StashEntry } from "@/models/app-state"
import { MultiCommitOperationKind } from "@/models/multi-commit-operation"
import type { RepoStatus } from "@/models/repo-status"
import { getStringArray, setStringArray } from "@/upstream/lib/local-storage"
import type { IMultiCommitOperationProgress } from "@/upstream/models/progress"

export const EMPTY_STATUS: RepoStatus = {
  branch: null,
  changes: [],
  remote: null,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  operation: null,
  theirs: null,
  unborn: false,
  head: null,
  fetchHead: null,
  pullWithRebase: null,
  upstream: null,
  upstreamRemoteName: null
}

/** Desktop Progress（models/progress.ts）里推拉按钮用到的部分：标题、说明、0–1 的进度 */
export interface NetworkProgress {
  kind: "push" | "pull" | "fetch" | "generic"
  title: string
  description?: string
  value: number
}

/** Desktop tags-to-push-storage 的键是 `tags-to-push-${repository.id}`；本项目的仓库以路径为身份（id 恒为 -1），改用路径 */
const tagsToPushKey = (repo: string) => `tags-to-push-${repo}`

/** Desktop storeTagsToPush：空列表就删掉这个键 */
function storeTagsToPush(repo: string, tagsToPush: readonly string[]) {
  if (tagsToPush.length === 0) localStorage.removeItem(tagsToPushKey(repo))
  else setStringArray(tagsToPushKey(repo), tagsToPush)
}

/** Desktop git-store updateLastFetched：FETCH_HEAD 为空多半是拉取失败，沿用上一次的时间；没有这个文件就是从没拉取过 */
export function nextLastFetched(fetchHead: RepoStatus["fetchHead"], previous: Date | null): Date | null {
  if (fetchHead === null) return null
  return fetchHead.empty ? previous : new Date(fetchHead.modifiedMs)
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
  /** 推送、拉取、获取进行中（Desktop networkActionInProgress 与 pushPullFetchProgress） */
  networkProgress: NetworkProgress | null
  /** Desktop gitStore.lastFetched：推拉按钮下面那行「Last fetched …」 */
  lastFetched: Date | null
  /** Desktop branchesState.forcePushBranches：本应用改写过（修订、变基、压缩、重排）的分支 → 改写后的提交。
   *  分支还停在这个提交上且与上游分叉时，推拉按钮建议强推。只在本次运行内记住，按仓库分开 */
  forcePushBranches: Record<string, Record<string, string>>
  /** Desktop multiCommitOperationState 的 ShowProgress 步骤：进行中的多提交操作与进度，进度为 null 时还没开始报 */
  multiCommitOperation: { kind: MultiCommitOperationKind; progress: IMultiCommitOperationProgress | null } | null
  setMultiCommitOperation: (
    repo: string,
    operation: { kind: MultiCommitOperationKind; progress: IMultiCommitOperationProgress | null } | null
  ) => void
  /** 变基停在冲突上时，改写前的 HEAD 先记在这里，「继续」做完再结算 */
  pendingRewrites: Record<string, string | null>
  /** Desktop updatePushPullFetchProgress：只认当前仓库的进度，切走之后旧仓库的进度不再显示 */
  setNetworkProgress: (repo: string, progress: NetworkProgress | null) => void
  /** Desktop git-store _tagsToPush：在本应用里新建、还没推送的标签，下次推送时带上 */
  tagsToPush: readonly string[]
  /** Desktop createTag 成功后 addTagToPush */
  addTagToPush: (repo: string, tagName: string) => void
  /** Desktop deleteTag 成功后，以及本地已找不到的标签 removeTagToPush */
  removeTagToPush: (repo: string, tagName: string) => void
  /** Desktop 推送成功后 clearTagsToPush */
  clearTagsToPush: (repo: string) => void
  /** Desktop _addBranchToForcePushList：改写前的提交与刷新后的 HEAD 不同才记 */
  addBranchToForcePushList: (repo: string, beforeChangeSha: string | null) => void
  /** 修订、变基、压缩、重排刷新之后调用（Desktop 在多提交操作完成时记）：还停在变基里就先挂起；
   *  不给 before 表示结算挂起的那次（冲突解决后「继续」），没有挂起就什么都不做 */
  settleRewrite: (repo: string, before?: string | null) => void
  /** 中止变基：挂起的那次不再记 */
  dropRewrite: (repo: string) => void
  /** Desktop multiCommitOperationState.operationDetail.kind：停在冲突上的变基原本是变基、压缩还是重排，继续时的进度标题用它 */
  rebaseKinds: Record<string, MultiCommitOperationKind>
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
    const lastFetched = nextLastFetched(next.fetchHead, getState().lastFetched)
    if (lastFetched?.getTime() !== getState().lastFetched?.getTime()) setState({ lastFetched })
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
    // Desktop refreshTags：在应用外删掉的未推送标签从待推送里去掉；没有待推送的标签就不必列标签
    if (getState().tagsToPush.length === 0) return
    const localTags = new Set(yield* call("tags", ipc => ipc.tags(repo)))
    if (repo !== activeRepository()) return
    for (const tag of getState().tagsToPush) if (!localTags.has(tag)) getState().removeTagToPush(repo, tag)
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
  networkProgress: null,
  lastFetched: null,
  forcePushBranches: {},
  pendingRewrites: {},
  multiCommitOperation: null,
  setMultiCommitOperation: (repo, multiCommitOperation) => {
    if (repo === activeRepository()) set({ multiCommitOperation })
    // 拣选不走 git rebase，继续时就是拣选
    if (multiCommitOperation && multiCommitOperation.kind !== MultiCommitOperationKind.CherryPick)
      set({ rebaseKinds: { ...get().rebaseKinds, [repo]: multiCommitOperation.kind } })
  },
  rebaseKinds: {},
  setNetworkProgress: (repo, networkProgress) => {
    if (repo === activeRepository()) set({ networkProgress })
  },
  tagsToPush: [],
  addTagToPush: (repo, tagName) => {
    const tagsToPush = [...getStringArray(tagsToPushKey(repo)), tagName]
    storeTagsToPush(repo, tagsToPush)
    if (repo === activeRepository()) set({ tagsToPush })
  },
  removeTagToPush: (repo, tagName) => {
    const tagsToPush = getStringArray(tagsToPushKey(repo)).filter(name => name !== tagName)
    storeTagsToPush(repo, tagsToPush)
    if (repo === activeRepository()) set({ tagsToPush })
  },
  clearTagsToPush: repo => {
    storeTagsToPush(repo, [])
    if (repo === activeRepository()) set({ tagsToPush: [] })
  },
  settleRewrite: (repo, before) => {
    const { status, pendingRewrites } = get()
    const pending = before === undefined ? pendingRewrites[repo] : before
    if (pending === undefined) return
    if (status.operation === "rebase") {
      set({ pendingRewrites: { ...pendingRewrites, [repo]: pending } })
      return
    }
    get().dropRewrite(repo)
    get().addBranchToForcePushList(repo, pending)
  },
  dropRewrite: repo => {
    const { [repo]: _, ...rest } = get().pendingRewrites
    const { [repo]: __, ...kinds } = get().rebaseKinds
    set({ pendingRewrites: rest, rebaseKinds: kinds })
  },
  addBranchToForcePushList: (repo, beforeChangeSha) => {
    const { status, forcePushBranches } = get()
    if (repo !== activeRepository() || !status.branch || !status.head || status.head === beforeChangeSha) return
    set({
      forcePushBranches: {
        ...forcePushBranches,
        [repo]: { ...forcePushBranches[repo], [status.branch]: status.head }
      }
    })
  },
  refresh: () => Promise.resolve(),
  bind: repo => {
    const runner = createCoalescingRunner(signal => runPromise(refreshRepository(repo), { signal }))
    // Desktop GitStore 构造时 getTagsToPush
    set({ refresh: runner, tagsToPush: repo ? getStringArray(tagsToPushKey(repo)) : [] })
    void runner()
    return () => runner.cancel()
  },
  reset: () =>
    set({
      status: EMPTY_STATUS,
      stashList: [],
      lfs: null,
      lastFetched: null,
      networkProgress: null,
      multiCommitOperation: null,
      error: null
    }),
  run: operation => {
    if (locked || get().busy) return Promise.resolve(undefined)
    locked = true
    set({ busy: true, error: null })
    return runPromise(
      attempt(operation).pipe(
        // Desktop performFailableOperation → emitError：操作失败一律进错误对话框（不论是不是当前仓库）
        Effect.catch(error =>
          Effect.sync(() => {
            useDialogsStore
              .getState()
              .postError(
                error._tag === "OperationError" ? toPresentableError(error.error) : new Error(describeError(error))
              )
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
