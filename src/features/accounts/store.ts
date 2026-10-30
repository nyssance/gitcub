/**
 * Accounts Store —— 仓库 origin 与各实例的账号。左栏（分组、图标）和设置页（按实例列出、登出）共用同一份，
 * 设置里登出后左栏立即跟着变。
 *
 * origin 只在仓库进出列表时读一次，刷新时顺带更新；读取失败单独记在 remoteErrors，不冒充「没有远端」。
 * 账号按实例分别请求、各自到各自更新：连不上的自建实例要等满超时，合在一批会把其它实例一起卡住。
 */
import equal from "deep-equal"
import { Effect } from "effect"
import { create } from "zustand"

import { call, runFork } from "@/features/effect-runtime"
import { getDesktopRuntime } from "@/lib/desktop-runtime"
import type { Accounts, Remote } from "@/models/app-state"

interface AccountsStore {
  /** 原始 origin；界面和平台请求用按账号主机规整过的版本（渲染时由 accountRemoteFor 计算） */
  rawRemotes: Record<string, Remote | null>
  remoteErrors: Record<string, string>
  accounts: Accounts
  loadRemotes: (repositories: readonly string[]) => void
  setRemote: (repo: string, remote: Remote | null) => void
  /** refresh=false 时只请求还没问过的实例；失败的实例只在显式刷新时重试。 */
  refreshAccounts: (hosts: readonly string[], refresh: boolean, onRejected: (host: string) => void) => void
}

const pendingRemotes = new Set<string>()
const requestedHosts = new Set<string>()
// 令牌被拒只提示一次；重新登录成功（unauthorized 消失）后允许再次提示
const rejectedHosts = new Set<string>()

export const useAccountsStore = create<AccountsStore>()((set, get) => ({
  rawRemotes: {},
  remoteErrors: {},
  accounts: {},
  loadRemotes: repositories => {
    const { rawRemotes, remoteErrors } = get()
    for (const repo of repositories) {
      if (repo in rawRemotes || repo in remoteErrors || pendingRemotes.has(repo)) continue
      pendingRemotes.add(repo)
      runFork(
        call("repoRemote", ipc => ipc.repoRemote(repo)).pipe(
          Effect.match({
            onSuccess: remote => set(store => ({ rawRemotes: { ...store.rawRemotes, [repo]: remote } })),
            onFailure: error => set(store => ({ remoteErrors: { ...store.remoteErrors, [repo]: error.message } }))
          }),
          Effect.ensuring(Effect.sync(() => pendingRemotes.delete(repo)))
        )
      )
    }
  },
  setRemote: (repo, remote) =>
    set(store =>
      equal(store.rawRemotes[repo], remote) ? store : { rawRemotes: { ...store.rawRemotes, [repo]: remote } }
    ),
  refreshAccounts: (hosts, refresh, onRejected) => {
    for (const host of hosts) {
      if (!refresh && requestedHosts.has(host)) continue
      requestedHosts.add(host)
      runFork(
        Effect.gen(function* () {
          const one = yield* call("accountInfo", ipc => ipc.accountInfo([host], refresh))
          set(store => ({ accounts: { ...store.accounts, ...one } }))
          if (one[host]?.unauthorized) {
            if (!rejectedHosts.has(host)) onRejected(host)
            rejectedHosts.add(host)
          } else rejectedHosts.delete(host)
          yield* call("synchronizeAccounts", () => getDesktopRuntime().synchronizeAccounts([host]))
        }).pipe(
          Effect.catch(error => Effect.sync(() => log.warn(`Unable to refresh account on ${host}`, error.message)))
        )
      )
    }
  }
}))
