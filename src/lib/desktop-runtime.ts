import { invoke } from "@tauri-apps/api/core"

import { API, fetchUser, getHTMLURL } from "./api"
import { GitHubUserDatabase } from "./databases/github-user-database"
import { IssuesDatabase } from "./databases/issues-database"
import { PullRequestDatabase } from "./databases/pull-request-database"
import { RepositoriesDatabase } from "./databases/repositories-database"
import { type IOAuthToken, refreshOAuthToken } from "./oauth-token"
import { StatsDatabase } from "./stats/stats-database"
import { StatsStore } from "./stats/stats-store"
import { AccountsStore } from "./stores/accounts-store"
import { AliveStore } from "./stores/alive-store"
import { ApiRepositoriesStore } from "./stores/api-repositories-store"
import { AppStore } from "./stores/app-store"
import { CloningRepositoriesStore } from "./stores/cloning-repositories-store"
import { GitHubUserStore } from "./stores/github-user-store"
import { IssuesStore } from "./stores/issues-store"
import { NotificationsStore } from "./stores/notifications-store"
import { PullRequestCoordinator } from "./stores/pull-request-coordinator"
import { PullRequestStore } from "./stores/pull-request-store"
import { RepositoriesStore } from "./stores/repositories-store"
import { RepositoryStateCache } from "./stores/repository-state-cache"
import { SignInStore } from "./stores/sign-in-store"
import { TokenStore } from "./token-store"
import { UiActivityMonitor } from "./ui/ui-activity-monitor"

/** One set of production stores per WebView; tests supply their own databases. */
function createRuntime() {
  const accountsStore = new AccountsStore(localStorage, TokenStore, async (endpoint, refreshToken) => {
    const native = await invoke<IOAuthToken | null>("native_renew_token", {
      host: new URL(getHTMLURL(endpoint)).host,
      refreshToken
    })
    return native ?? refreshOAuthToken(endpoint, refreshToken)
  })
  API.setTokenProvider(async (endpoint, token) => {
    const host = new URL(getHTMLURL(endpoint)).host
    const native = await invoke<string | null>("native_account_token", { host, token })
    return native ?? accountsStore.resolveToken(endpoint, token)
  })
  API.onTokenInvalidated(accountsStore.handleTokenInvalidated)
  const repositoriesStore = new RepositoriesStore(new RepositoriesDatabase("gitcub-repositories"))
  const gitHubUserStore = new GitHubUserStore(new GitHubUserDatabase("gitcub-users"))
  const issuesStore = new IssuesStore(new IssuesDatabase("gitcub-issues"))
  const pullRequestStore = new PullRequestStore(new PullRequestDatabase("gitcub-pull-requests"), repositoriesStore)
  const pullRequestCoordinator = new PullRequestCoordinator(pullRequestStore, repositoriesStore)
  const metricsEndpoint = import.meta.env.VITE_METRICS_ENDPOINT
  const statsStore = new StatsStore(
    new StatsDatabase("gitcub-stats"),
    new UiActivityMonitor(),
    metricsEndpoint
      ? body =>
          fetch(metricsEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          })
      : null
  )
  const repositoryStateCache = new RepositoryStateCache(statsStore)
  const signInStore = new SignInStore(accountsStore)

  const notificationsStore = new NotificationsStore(
    accountsStore,
    new AliveStore(accountsStore),
    pullRequestCoordinator,
    statsStore
  )
  const appStore = new AppStore(
    gitHubUserStore,
    new CloningRepositoriesStore(),
    issuesStore,
    statsStore,
    signInStore,
    accountsStore,
    repositoriesStore,
    pullRequestCoordinator,
    repositoryStateCache,
    new ApiRepositoriesStore(accountsStore),
    notificationsStore
  )
  appStore.onDidError(error => log.error("Application store error", error))
  void accountsStore.getAll().catch(error => log.error("Unable to load accounts", error))
  void repositoriesStore.getAll().catch(error => log.error("Unable to load repositories", error))
  const synchronizations = new Map<string, Promise<void>>()
  async function synchronizeHost(host: string) {
    const session = await invoke<[string, string] | null>("desktop_account_session", { host })
    const current = (await accountsStore.getAll()).find(account => new URL(getHTMLURL(account.endpoint)).host === host)
    if (session === null) {
      if (current) await accountsStore.removeAccount(current)
    } else {
      const [endpoint, token] = session
      if (current?.token !== token) {
        const account = await fetchUser(endpoint, token)
        const latest = await invoke<[string, string] | null>("desktop_account_session", { host })
        if (latest?.[0] !== endpoint || latest?.[1] !== token) return
        if (!(await accountsStore.addAccount(account))) throw new Error("Unable to save the account")
      }
    }
  }
  return {
    async synchronizeAccounts(hosts: readonly string[]) {
      await Promise.all(
        hosts.map(host => {
          const previous = synchronizations.get(host) ?? Promise.resolve()
          const next = previous.catch(() => {}).then(() => synchronizeHost(host))
          synchronizations.set(host, next)
          return next.finally(() => {
            if (synchronizations.get(host) === next) synchronizations.delete(host)
          })
        })
      )
    },
    appStore,
    accountsStore,
    repositoriesStore,
    signInStore,
    statsStore,

    issuesStore,
    gitHubUserStore,
    repositoryStateCache
  }
}
let runtime: ReturnType<typeof createRuntime> | undefined
export function getDesktopRuntime() {
  runtime ??= createRuntime()
  return runtime
}
