// Desktop MIT application coordination: account lifecycle and
// repository indicators extracted with their complete dependency closure.
// Window/layout and other UI workflows are owned by GitCub's React application.
import { type Account } from "../../models/account"
import { CloningRepository } from "../../models/cloning-repository"
import { hasWritePermission } from "../../models/github-repository"
import { type Popup, PopupType } from "../../models/popup"
import {
  type ILocalRepositoryState,
  isRepositoryWithGitHubRepository,
  nameOf,
  Repository
} from "../../models/repository"
import { TipState } from "../../models/tip"
import { getAppMenu, updateAccounts } from "../../ui/main-process-proxy"
import type { EndpointToken } from "../../upstream/lib/endpoint-token"
import { getBoolean, setBoolean } from "../../upstream/lib/local-storage"
import { BaseStore } from "../../upstream/lib/stores/base-store"
import type { Progress } from "../../upstream/models/progress"
import { RepoRulesInfo } from "../../upstream/models/repo-rules"
import { API, getAccountForEndpoint, type IAPIRepoRuleset } from "../api"
import { shell } from "../app-shell"
import { getAccountForRepository } from "../get-account-for-repository"
import { isBranchPushable } from "../helpers/push-control"
import { inferLastPushForRepository } from "../infer-last-push-for-repository"
import { pathExists } from "../native-path-exists"
import { PopupManager } from "../popup-manager"
import { parseRepoRules, useRepoRulesLogic as shouldUseRepoRulesLogic } from "../repo-rules"
import { type IMatchedGitHubRepository, matchGitHubRepository } from "../repository-matching"
import type { StatsStore } from "../stats/stats-store"
import type { IStatusResult } from "../status-contract"
import type { AccountsStore } from "./accounts-store"
import type { ApiRepositoriesStore } from "./api-repositories-store"
import type { CloningRepositoriesStore } from "./cloning-repositories-store"
import { GitStoreCache } from "./git-store-cache"
import type { GitHubUserStore } from "./github-user-store"
import { findRemoteBranchName } from "./helpers/find-branch-name"
import { RepositoryIndicatorUpdater } from "./helpers/repository-indicator-updater"
import type { IssuesStore } from "./issues-store"
import type { NotificationsStore } from "./notifications-store"
import type { PullRequestCoordinator } from "./pull-request-coordinator"
import type { RepositoriesStore } from "./repositories-store"
import type { RepositoryStateCache } from "./repository-state-cache"
import type { SignInStore } from "./sign-in-store"
import { updateRemoteUrl } from "./updates/update-remote-url"

const BackgroundFetchMinimumInterval = 30 * 60 * 1000
const InitialRepositoryIndicatorTimeout = 2 * 60 * 1000
const repositoryIndicatorsEnabledKey = "enable-repository-indicators"

export class AppStore extends BaseStore {
  private readonly repositoryIndicatorUpdater: RepositoryIndicatorUpdater
  private repositoryIndicatorsEnabled = true
  private readonly popupManager = new PopupManager()
  private readonly subscriptions: Array<{ dispose(): void }> = []
  private readonly indicatorStartupTimer: number

  public constructor(
    private readonly gitHubUserStore: GitHubUserStore,
    private readonly cloningRepositoriesStore: CloningRepositoriesStore,
    _issuesStore: IssuesStore,
    private readonly statsStore: StatsStore,
    private readonly signInStore: SignInStore,
    private readonly accountsStore: AccountsStore,
    private readonly repositoriesStore: RepositoriesStore,
    private readonly pullRequestCoordinator: PullRequestCoordinator,
    private readonly repositoryStateCache: RepositoryStateCache,
    private readonly apiRepositoriesStore: ApiRepositoriesStore,
    _notificationsStore: NotificationsStore
  ) {
    super()
    this.gitStoreCache = new GitStoreCache(
      shell,
      this.statsStore,
      () => this.emitUpdate(),
      error => this.emitError(error)
    )
    this.wireupStoreEventHandlers()
    getAppMenu()
    if (getBoolean(repositoryIndicatorsEnabledKey) === undefined) {
      setBoolean(repositoryIndicatorsEnabledKey, true)
    }
    this.repositoryIndicatorsEnabled = getBoolean(repositoryIndicatorsEnabledKey) ?? true
    this.repositoryIndicatorUpdater = new RepositoryIndicatorUpdater(
      this.getRepositoriesForIndicatorRefresh,
      this.refreshIndicatorForRepository
    )
    this.indicatorStartupTimer = window.setTimeout(() => {
      if (this.repositoryIndicatorsEnabled) this.repositoryIndicatorUpdater.start()
    }, InitialRepositoryIndicatorTimeout)
  }
  public dispose() {
    window.clearTimeout(this.indicatorStartupTimer)
    this.repositoryIndicatorUpdater.stop()
    this.repositoryIndicatorUpdater.resume()
    this.subscriptions.forEach(subscription => {
      subscription.dispose()
    })
  }
  public selectRepository(repository: Repository | CloningRepository | null) {
    this.selectedRepository = repository
    this.emitUpdate()
  }
  public getState() {
    return {
      accounts: this.accounts,
      repositories: this.repositories,
      selectedRepository: this.selectedRepository,
      localRepositoryStateLookup: new Map(this.localRepositoryStateLookup),

      currentPopup: this.popupManager.currentPopup
    }
  }
  public closePopup() {
    const popup = this.popupManager.currentPopup
    if (popup) this.popupManager.removePopup(popup)
    this.emitUpdate()
  }
  private _showPopup(popup: Popup) {
    this.popupManager.addPopup(popup)
    this.emitUpdate()
  }
  private wireupStoreEventHandlers() {
    this.subscriptions.push(
      this.accountsStore.onDidUpdate(accounts => {
        this.accounts = accounts
        this.statsStore.setUsesShortLivedToken(accounts.some(account => this.accountsStore.isRefreshable(account)))

        const endpointTokens = accounts.map<EndpointToken>(({ endpoint, token }) => ({ endpoint, token }))

        updateAccounts(endpointTokens)

        this.refreshSelectedRepositoryAfterAccountChange()

        this.emitUpdate()
      })
    )
    this.subscriptions.push(this.accountsStore.onDidError(error => this.emitError(error)))
    this.subscriptions.push(
      this.accountsStore.onTokenRefreshEvent(event => {
        void this.statsStore.recordTokenRefreshEvent(event).catch(error => {
          log.error("Failed recording token refresh stats", error)
        })
      })
    )
    this.subscriptions.push(
      this.accountsStore.onTokenInvalidated(account => {
        this._showPopup({ type: PopupType.InvalidatedToken, account })
      })
    )

    this.subscriptions.push(
      this.repositoriesStore.onDidUpdate(repositories => {
        this.repositories = repositories
        if (this.selectedRepository instanceof Repository) {
          this.selectedRepository = repositories.find(repo => repo.id === this.selectedRepository?.id) ?? null
        }
        this.emitUpdate()
      })
    )
    for (const store of [
      this.gitHubUserStore,
      this.cloningRepositoriesStore,
      this.signInStore,
      this.apiRepositoriesStore
    ]) {
      this.subscriptions.push(store.onDidUpdate(() => this.emitUpdate()))
      this.subscriptions.push(store.onDidError(error => this.emitError(error)))
    }

    this.subscriptions.push(
      this.pullRequestCoordinator.onIsLoadingPullRequests((repository, isLoadingPullRequests) => {
        this.repositoryStateCache.updateBranchesState(repository, () => ({ isLoadingPullRequests }))
        this.emitUpdate()
      })
    )
  }

  private getRepositoriesForIndicatorRefresh = () => {
    // The currently selected repository will get refreshed by both the
    // BackgroundFetcher and the refreshRepository call from the
    // focus event. No point in having the RepositoryIndicatorUpdater do
    // it as well.
    //
    // Repository-list reloads can create a different object for the selected
    // database row, so compare IDs rather than references. Cloning selections
    // aren't local repositories and must not exclude an entry with the same ID.
    //
    // Note that this method should never leak the actual repositories
    // instance since that's a mutable array. We should always return
    // a copy.
    const selectedRepositoryID = this.selectedRepository instanceof Repository ? this.selectedRepository.id : null
    return this.repositories.filter(x => x.id !== selectedRepositoryID)
  }

  /**
   * Refresh indicator in repository list for a specific repository
   */
  private refreshIndicatorForRepository = async (repository: Repository) => {
    const lookup = this.localRepositoryStateLookup

    if (repository.missing) {
      lookup.delete(repository.id)
      return
    }

    const exists = await pathExists(repository.path)
    if (!exists) {
      lookup.delete(repository.id)
      return
    }

    const gitStore = this.gitStoreCache.get(repository)
    const status = await gitStore.loadStatus()
    if (status === null) {
      lookup.delete(repository.id)
      return
    }

    this.updateSidebarIndicator(repository, status)
    this.emitUpdate()

    const lastPush = await inferLastPushForRepository(this.accounts, gitStore, repository)

    if (await this.shouldBackgroundFetch(repository, lastPush)) {
      const aheadBehind = await this.fetchForRepositoryIndicator(repository)

      const existing = lookup.get(repository.id)
      lookup.set(repository.id, {
        aheadBehind,
        // We don't need to update changedFilesCount here since it was already
        // set when calling `updateSidebarIndicator()` with the status object.
        changedFilesCount: existing?.changedFilesCount ?? 0
      })
      this.emitUpdate()
    }
  }

  /**
   * Refreshes the GitHub repository information for the currently selected
   * repository when the active account changes. This ensures that permission
   * information is updated after signing in/out.
   */
  private async refreshSelectedRepositoryAfterAccountChange() {
    const repository = this.selectedRepository

    if (repository === null || repository instanceof CloningRepository) {
      return
    }

    if (!isRepositoryWithGitHubRepository(repository)) {
      return
    }

    await this.repositoryWithRefreshedGitHubRepository(repository)
  }

  private selectedRepository: Repository | CloningRepository | null = null

  private repositories: ReadonlyArray<Repository> = [] as Repository[]

  private readonly localRepositoryStateLookup = new Map<number, ILocalRepositoryState>()

  private readonly gitStoreCache: GitStoreCache

  /**
   * Update the repository sidebar indicator for the repository
   */
  private async updateSidebarIndicator(repository: Repository, status: IStatusResult | null): Promise<void> {
    const lookup = this.localRepositoryStateLookup

    if (repository.missing) {
      lookup.delete(repository.id)
      return
    }

    if (status === null) {
      lookup.delete(repository.id)
      return
    }

    lookup.set(repository.id, {
      aheadBehind: status.branchAheadBehind ?? null,
      changedFilesCount: status.workingDirectory.files.length
    })
  }

  private accounts: ReadonlyArray<Account> = [] as Account[]

  private async shouldBackgroundFetch(repository: Repository, lastPush: Date | null): Promise<boolean> {
    const gitStore = this.gitStoreCache.get(repository)
    const lastFetched = await gitStore.updateLastFetched()

    if (lastFetched === null) {
      return true
    }

    const now = new Date()
    const timeSinceFetch = now.getTime() - lastFetched.getTime()
    const repoName = nameOf(repository)
    if (timeSinceFetch < BackgroundFetchMinimumInterval) {
      const timeInSeconds = Math.floor(timeSinceFetch / 1000)

      log.debug(`Skipping background fetch as '${repoName}' was fetched ${timeInSeconds}s ago`)
      return false
    }

    if (lastPush === null) {
      return true
    }

    // we should fetch if the last push happened after the last fetch
    if (lastFetched < lastPush) {
      return true
    }

    log.debug(
      `Skipping background fetch since nothing has been pushed to '${repoName}' since the last fetch at ${lastFetched}`
    )

    return false
  }

  /**
   * A slimmed down version of performFetch which is only used when fetching
   * the repository in order to compute the repository indicator status.
   *
   * As opposed to `performFetch` this method will not perform a full refresh
   * of the repository after fetching, nor will it refresh issues, branch
   * protection information etc. It's intention is to only do the bare minimum
   * amount of work required to calculate an up-to-date ahead/behind status
   * of the current branch to its upstream tracking branch.
   */
  private fetchForRepositoryIndicator(repo: Repository) {
    return this.withRefreshedGitHubRepository(repo, async repo => {
      const isBackgroundTask = true
      const gitStore = this.gitStoreCache.get(repo)

      await this.withPushPullFetch(repo, () =>
        gitStore.fetch(isBackgroundTask, progress => this.updatePushPullFetchProgress(repo, progress))
      )
      this.updatePushPullFetchProgress(repo, null)

      return gitStore.aheadBehind
    })
  }

  /**
   * refetches the associated GitHub remote repository, if possible
   *
   * if refetching fails, will return the given `repository` with
   * the same info it was passed in with
   *
   * @param repository
   * @returns repository model (hopefully with fresh `gitHubRepository` info)
   */
  private async repositoryWithRefreshedGitHubRepository(repository: Repository): Promise<Repository> {
    const repoStore = this.repositoriesStore
    const match = await this.matchGitHubRepository(repository)

    // TODO: We currently never clear GitHub repository associations (see
    // https://github.com/desktop/desktop/issues/1144). So we can bail early at
    // this point.
    if (!match) {
      return repository
    }

    const { account, owner, name } = match
    const { endpoint } = account
    const api = API.fromAccount(account)
    const apiRepo = await api.fetchRepository(owner, name)

    if (apiRepo === null) {
      // If the request fails, we want to preserve the existing GitHub
      // repository info. But if we didn't have a GitHub repository already or
      // the endpoint changed, the skeleton repository is better than nothing.
      if (endpoint !== repository.gitHubRepository?.endpoint) {
        const ghRepo = await repoStore.upsertGitHubRepositoryFromMatch(match)
        return repoStore.setGitHubRepository(repository, ghRepo)
      }

      return repository
    }

    if (repository.gitHubRepository) {
      const gitStore = this.gitStoreCache.get(repository)
      await updateRemoteUrl(gitStore, repository.gitHubRepository, apiRepo)
    }

    const ghRepo = await repoStore.upsertGitHubRepository(endpoint, apiRepo)
    const freshRepo = await repoStore.setGitHubRepository(repository, ghRepo)

    await this.refreshBranchProtectionState(freshRepo)
    return freshRepo
  }

  private async withRefreshedGitHubRepository<T>(
    repository: Repository,
    fn: (repository: Repository) => Promise<T>
  ): Promise<T> {
    let updatedRepository = repository
    const account: Account | null = getAccountForRepository(this.accounts, updatedRepository)

    // If we don't have a user association, it might be because we haven't yet
    // tried to associate the repository with a GitHub repository, or that
    // association is out of date. So try again before we bail on providing an
    // authenticating user.
    if (!account) {
      updatedRepository = await this.repositoryWithRefreshedGitHubRepository(repository)
    }

    return fn(updatedRepository)
  }

  private async withPushPullFetch(repository: Repository, fn: () => Promise<void>): Promise<void> {
    const state = this.repositoryStateCache.get(repository)
    // Don't allow concurrent network operations.
    if (state.isPushPullFetchInProgress) {
      return
    }

    this.repositoryStateCache.update(repository, () => ({
      isPushPullFetchInProgress: true
    }))
    this.emitUpdate()

    try {
      await fn()
    } finally {
      this.repositoryStateCache.update(repository, () => ({
        isPushPullFetchInProgress: false
      }))
      this.emitUpdate()
    }
  }

  private updatePushPullFetchProgress(repository: Repository, pushPullFetchProgress: Progress | null) {
    this.repositoryStateCache.update(repository, () => ({
      pushPullFetchProgress
    }))
    if (this.selectedRepository === repository) {
      this.emitUpdate()
    }
  }

  private async matchGitHubRepository(repository: Repository): Promise<IMatchedGitHubRepository | null> {
    const gitStore = this.gitStoreCache.get(repository)

    if (!gitStore.defaultRemote) {
      await gitStore.loadRemotes()
    }

    const remote = gitStore.defaultRemote
    return remote !== null ? matchGitHubRepository(this.accounts, remote.url) : null
  }

  private async refreshBranchProtectionState(repository: Repository) {
    const { tip, currentRemote } = this.gitStoreCache.get(repository)

    if (tip.kind !== TipState.Valid || repository.gitHubRepository === null) {
      return
    }

    const gitHubRepo = repository.gitHubRepository
    const branchName = findRemoteBranchName(tip, currentRemote, gitHubRepo)

    if (branchName !== null) {
      const account = getAccountForEndpoint(this.accounts, gitHubRepo.endpoint)

      if (account === null) {
        return
      }

      // If the user doesn't have write access to the repository
      // it doesn't matter if the branch is protected or not and
      // we can avoid the API call. See the `showNoWriteAccess`
      // prop in the `CommitMessage` component where we specifically
      // test for this scenario and show a message specifically
      // about write access before showing a branch protection
      // warning.
      if (!hasWritePermission(gitHubRepo)) {
        this.repositoryStateCache.updateChangesState(repository, () => ({
          currentBranchProtected: false,
          currentRepoRulesInfo: new RepoRulesInfo()
        }))
        this.emitUpdate()
        return
      }

      const name = gitHubRepo.name
      const owner = gitHubRepo.owner.login
      const api = API.fromAccount(account)

      const pushControl = await api.fetchPushControl(owner, name, branchName)
      const currentBranchProtected = !isBranchPushable(pushControl)

      let currentRepoRulesInfo = new RepoRulesInfo()
      if (shouldUseRepoRulesLogic(account, repository)) {
        const slimRulesets = await api.fetchAllRepoRulesets(owner, name)

        // ultimate goal here is to fetch all rulesets that apply to the repo
        // so they're already cached when needed later on
        if (slimRulesets?.length) {
          const rulesetIds = slimRulesets.map(r => r.id)

          const calls: Promise<IAPIRepoRuleset | null>[] = []
          for (const id of rulesetIds) {
            // check the cache and don't re-query any that are already in there
            if (!this.cachedRepoRulesets.has(id)) {
              calls.push(api.fetchRepoRuleset(owner, name, id))
            }
          }

          if (calls.length > 0) {
            const rulesets = await Promise.all(calls)
            this._updateCachedRepoRulesets(rulesets)
          }
        }

        const branchRules = await api.fetchRepoRulesForBranch(owner, name, branchName)

        if (branchRules.length > 0) {
          currentRepoRulesInfo = await parseRepoRules(branchRules, this.cachedRepoRulesets, repository)
        }
      }

      this.repositoryStateCache.updateChangesState(repository, () => ({
        currentBranchProtected,
        currentRepoRulesInfo
      }))
      this.emitUpdate()
    }
  }

  private cachedRepoRulesets = new Map<number, IAPIRepoRuleset>()

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _updateCachedRepoRulesets(rulesets: Array<IAPIRepoRuleset | null>) {
    for (const rs of rulesets) {
      if (rs !== null) {
        this.cachedRepoRulesets.set(rs.id, rs)
      }
    }
  }

  public _setRepositoryIndicatorsEnabled(repositoryIndicatorsEnabled: boolean) {
    if (this.repositoryIndicatorsEnabled === repositoryIndicatorsEnabled) {
      return
    }

    setBoolean(repositoryIndicatorsEnabledKey, repositoryIndicatorsEnabled)
    this.repositoryIndicatorsEnabled = repositoryIndicatorsEnabled
    if (repositoryIndicatorsEnabled) {
      this.repositoryIndicatorUpdater.start()
    } else {
      this.repositoryIndicatorUpdater.stop()
    }

    this.emitUpdate()
  }
}
