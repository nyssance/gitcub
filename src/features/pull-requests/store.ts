/**
 * Pull Requests Store —— 当前仓库的开放 PR / MR。
 *
 * 原版在选中仓库时由 PullRequestCoordinator 后台加载，分支下拉的「Pull Requests」页签和
 * 数量气泡读同一份。这里换仓库（远端）时加载一次，页签里的刷新按钮重新取；
 * 换远端时中断上一次请求，过期结果不会落进来。
 */
import { Effect } from "effect"
import { create } from "zustand"

import { call, describeError, forkCancelable } from "@/features/effect-runtime"
import type { PullRequest, Remote } from "@/models/app-state"

interface PullRequestsStore {
  /** 请求针对的仓库远端 */
  remote: Remote | null
  /** 实际列 PR 的仓库：fork 时是上游 */
  target: Remote | null
  list: PullRequest[]
  loading: boolean
  error: string | null
  /** 远端变了才重新加载；同一个远端什么都不做 */
  load: (remote: Remote | null) => void
  /** 打开页签时用：同一个远端就保留列表重新取，换了远端就从头加载 */
  revalidate: (remote: Remote | null) => void
  refresh: () => void
}

const sameRemote = (a: Remote | null, b: Remote | null) =>
  a === b || (!!a && !!b && a.host === b.host && a.owner === b.owner && a.name === b.name)

let cancel = () => {}

const fetchPullRequests = (remote: Remote) =>
  Effect.gen(function* () {
    const target = yield* call("pullRequestRepository", ipc =>
      ipc.pullRequestRepository(remote.host, remote.owner, remote.name)
    )
    const list = yield* call("pullRequests", ipc => ipc.pullRequests(target.host, target.owner, target.name, true))
    usePullRequestsStore.setState({ target, list, loading: false })
  }).pipe(
    Effect.catch(error =>
      Effect.sync(() => usePullRequestsStore.setState({ error: describeError(error), loading: false }))
    )
  )

export const usePullRequestsStore = create<PullRequestsStore>((set, get) => ({
  remote: null,
  target: null,
  list: [],
  loading: false,
  error: null,
  load: remote => {
    if (sameRemote(get().remote, remote)) return
    cancel()
    set({ remote, target: null, list: [], error: null, loading: !!remote })
    cancel = remote ? forkCancelable(fetchPullRequests(remote)) : () => {}
  },
  revalidate: remote => (sameRemote(get().remote, remote) ? get().refresh() : get().load(remote)),
  refresh: () => {
    const { remote } = get()
    if (!remote) return
    cancel()
    // 原版刷新时列表不清空，只让刷新按钮转起来
    set({ error: null, loading: true })
    cancel = forkCancelable(fetchPullRequests(remote))
  }
}))
