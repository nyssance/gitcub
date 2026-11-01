import { emit, listen } from "@tauri-apps/api/event"
import { confirm, open } from "@tauri-apps/plugin-dialog"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import type { PanelImperativeHandle } from "react-resizable-panels"

import { useAccountsStore } from "@/features/accounts/store"
import { activeRepository, useAppStateStore } from "@/features/app-state/store"
import { type FileState, useChangesStore } from "@/features/changes/store"
import { hookFailureHandling, selectDialogBlocking, useDialogsStore } from "@/features/dialogs/store"
import { useHistoryStore } from "@/features/history/store"
import { usePreferencesStore } from "@/features/preferences/store"
import { usePullRequestsStore } from "@/features/pull-requests/store"
import { useRepositoryIndicatorsStore } from "@/features/repository-indicators/store"
import { type NetworkProgress, useRepositoryStore } from "@/features/repository/store"
import { useWorkspaceStore } from "@/features/workspace/store"
import { accountRemoteFor } from "@/lib/account-host"
import {
  BranchWorkflowError,
  checkoutWithStash,
  cherryPickToBranch,
  createStashAndDropPreviousEntry,
  pushWithRecovery
} from "@/lib/branch-workflows"
import { getGlobalConfigValue, getRemoteHEAD } from "@/lib/desktop-git"
import { getDesktopRuntime } from "@/lib/desktop-runtime"
import { ErrorWithMetadata, type IErrorMetadata } from "@/lib/error-with-metadata"
import { fetch as fetchRemote, pull as pullRemote } from "@/lib/fetch"
import { ForcePushBranchState, getCurrentBranchForcePushState } from "@/lib/force-push-state"
import { contributesToParent, contributionRepository } from "@/lib/fork-contribution"
import type { HookCallbackOptions } from "@/lib/git-execution"
import i18n from "@/lib/i18n"
import { ipc } from "@/lib/ipc"
import { useNativeMenu } from "@/lib/menu/use-native-menu"
import { parse, routes } from "@/lib/navigate"
import { desktopStashForBranch } from "@/lib/no-changes-suggestions"
import { toPresentableError } from "@/lib/presentable-error"
import { cherryPickToPullRequest, findPullRequestBranch, sameHostedRepository } from "@/lib/pull-request-checkout"
import { push } from "@/lib/push"
import { handleShortcut } from "@/lib/shortcuts"
import { applySelection, discardLines } from "@/lib/stage"
import { applyTheme } from "@/lib/theme"
import type { CommitOptions } from "@/models/app-state"
import { Branch, BranchType } from "@/models/branch"
import { MultiCommitOperationKind } from "@/models/multi-commit-operation"
import { Repository } from "@/models/repository"
import { type RetryAction, RetryActionType } from "@/models/retry-actions"
import { AppError } from "@/ui/app-error"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/ui/base/alert-dialog"
import { Checkbox } from "@/ui/base/checkbox"
import { Input } from "@/ui/base/input"
import { Label } from "@/ui/base/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/base/tabs"
import { TooltipProvider } from "@/ui/base/tooltip"
import { Blame } from "@/ui/blame/blame"
import { PullRequestBadge } from "@/ui/branches/pull-request-badge"
import { Banner } from "@/ui/changes/banner"
import { Conflicts } from "@/ui/changes/conflicts"
import { NoChanges } from "@/ui/changes/no-changes"
import { ChangesSidebar } from "@/ui/changes/sidebar"
import { Stashes } from "@/ui/changes/stashes"
import { CommitProgress } from "@/ui/commit-progress/commit-progress"
import { DiffView } from "@/ui/diff/lazy-diff"
import { SubmoduleView } from "@/ui/diff/submodule"
import { CommitDetails } from "@/ui/history/commit-details"
import { headHistory, HistorySidebar } from "@/ui/history/sidebar"
import { HookFailed } from "@/ui/hook-failed/hook-failed"
import { Inbox } from "@/ui/inbox/inbox"
import { FloatingWorkspace } from "@/ui/layout/floating-workspace"
import { LocalChangesOverwrittenDialog } from "@/ui/local-changes-overwritten/local-changes-overwritten-dialog"
import { ProgressDialog } from "@/ui/multi-commit-operation/progress-dialog"
import { NoRepositoriesView } from "@/ui/no-repositories/no-repositories-view"
import { Preferences } from "@/ui/preferences/preferences"
import { CreatePullRequest } from "@/ui/pull-requests/create"
import { PullRequests } from "@/ui/pull-requests/list"
import { RepositorySettings } from "@/ui/repository-settings/repository-settings"
import { PublishRepository } from "@/ui/repository/publish"
import { RepositoryRail } from "@/ui/repository/repository-rail"
import { RepositorySplit } from "@/ui/repository/repository-split"
import { InlineError } from "@/ui/shared/inline-error"
import { ChangeStatusIcon, CommitStatusIcon } from "@/ui/shared/status-icon"
import { StashAndSwitchBranch } from "@/ui/stash-changes/stash-and-switch-branch-dialog"
import { ToolbarRight } from "@/ui/toolbar/toolbar"
import { Discover } from "@/ui/trending/discover"
import { TitleBar, useIsWindows } from "@/ui/window/title-bar"
import { sanitizeCloneName } from "@/upstream/lib/remote-parsing"
import type { IRawDiff } from "@/upstream/models/diff"
import { DiffSelectionType } from "@/upstream/models/diff/diff-selection"
import type { IMultiCommitOperationProgress } from "@/upstream/models/progress"
import { UncommittedChangesStrategy } from "@/upstream/models/uncommitted-changes-strategy"

import { Worktrees } from "./worktrees/worktrees"

/** 还没加载 Desktop 的 emoji 表；RichText 按空表渲染（:shortcode: 原样显示） */

/** Desktop dispatcher.postError：进错误对话框；后端回来的 git 输出照 Desktop 识别种类、配上说明 */
const showError = (error: unknown) => useDialogsStore.getState().postError(toPresentableError(error))

/** Desktop gitStore.performFailableOperation 给错误附上的 repository 与 retryAction（错误处理器靠它们决定怎么接） */
const withRetry =
  (path: string, retryAction: (repository: Repository) => RetryAction, extra?: IErrorMetadata) =>
  (error: unknown): never => {
    const repository = new Repository(path, -1, null, false)
    throw new ErrorWithMetadata(toPresentableError(error), {
      repository,
      retryAction: retryAction(repository),
      ...extra
    })
  }
const noEmoji = new Map()
export function App() {
  const { t } = useTranslation()
  // 状态按功能分在 features/*/store.ts；这里只订阅、派生和组合。
  const state = useAppStateStore(s => s.state)
  const patch = useAppStateStore(s => s.patch)
  const setState = useAppStateStore(s => s.update)
  const initialWidth = useAppStateStore(s => s.initialWidth)

  const status = useRepositoryStore(s => s.status)
  const multiCommitOperation = useRepositoryStore(s => s.multiCommitOperation)
  const tagsToPush = useRepositoryStore(s => s.tagsToPush)
  const stashList = useRepositoryStore(s => s.stashList)
  const lfs = useRepositoryStore(s => s.lfs)
  const setLfs = useRepositoryStore(s => s.setLfs)
  const issues = useRepositoryStore(s => s.issues)
  const mentionables = useRepositoryStore(s => s.mentionables)
  const author = useRepositoryStore(s => s.author)
  const setAuthor = useRepositoryStore(s => s.setAuthor)
  const reloadKey = useRepositoryStore(s => s.reloadKey)
  const diffKey = useRepositoryStore(s => s.diffKey)
  const error = useRepositoryStore(s => s.error)
  const errors = useDialogsStore(s => s.errors)
  const clearError = useDialogsStore(s => s.clearError)
  const localChangesOverwritten = useDialogsStore(s => s.localChangesOverwritten)
  const dismissLocalChangesOverwritten = useDialogsStore(s => s.dismissLocalChangesOverwritten)
  const busy = useRepositoryStore(s => s.busy)
  const showProgress = useRepositoryStore(s => s.showProgress)
  const refresh = useRepositoryStore(s => s.refresh)
  const run = useRepositoryStore(s => s.run)

  const selected = useChangesStore(s => s.selected)
  const setSelected = useChangesStore(s => s.setSelected)
  const fileSelection = useChangesStore(s => s.fileSelection)
  const setFileSelection = useChangesStore(s => s.setFileSelection)
  const files = useChangesStore(s => s.files)
  const setFiles = useChangesStore(s => s.setFiles)
  const diff = useChangesStore(s => s.diff)
  const tokens = useChangesStore(s => s.tokens)
  const lineEndings = useChangesStore(s => s.lineEndings)
  const diffError = useChangesStore(s => s.diffError)
  const blaming = useChangesStore(s => s.blaming)
  const setBlaming = useChangesStore(s => s.setBlaming)

  const asking = useDialogsStore(s => s.asking)
  const answer = useDialogsStore(s => s.answer)
  const ask = useDialogsStore(s => s.ask)
  const askingText = useDialogsStore(s => s.askingText)
  const askText = useDialogsStore(s => s.askText)
  const setAskingTextValue = useDialogsStore(s => s.setAskingTextValue)
  const answerText = useDialogsStore(s => s.answerText)
  const stashPrompt = useDialogsStore(s => s.stashPrompt)
  const answerStashPrompt = useDialogsStore(s => s.answerStashPrompt)
  const promptStashAndSwitch = useDialogsStore(s => s.promptStashAndSwitch)
  const prefsOpen = useDialogsStore(s => s.prefsOpen)
  const setPrefsOpen = useDialogsStore(s => s.setPrefsOpen)
  const prefsTab = useDialogsStore(s => s.prefsTab)
  const openPreferences = useDialogsStore(s => s.openPreferences)
  const worktreesOpen = useDialogsStore(s => s.worktreesOpen)
  const repositorySettingsOpen = useDialogsStore(s => s.repositorySettingsOpen)
  const setWorktreesOpen = useDialogsStore(s => s.setWorktreesOpen)
  const creatingPr = useDialogsStore(s => s.creatingPr)
  const setCreatingPr = useDialogsStore(s => s.setCreatingPr)
  const publishing = useDialogsStore(s => s.publishing)
  const setPublishing = useDialogsStore(s => s.setPublishing)
  const discarding = useDialogsStore(s => s.discarding)
  const setDiscarding = useDialogsStore(s => s.setDiscarding)
  const dialogBlocking = useDialogsStore(selectDialogBlocking)
  const hookFailed = useDialogsStore(s => s.hookFailed)
  const dismissHookFailed = useDialogsStore(s => s.dismissHookFailed)
  const commitProgress = useDialogsStore(s => s.commitProgress)
  const setCommitProgress = useDialogsStore(s => s.setCommitProgress)

  const canvasPage = useWorkspaceStore(s => s.canvasPage)
  const setCanvasPage = useWorkspaceStore(s => s.setCanvasPage)
  const route = useWorkspaceStore(s => s.route)
  const setRoute = useWorkspaceStore(s => s.setRoute)
  const stashesVisible = useWorkspaceStore(s => s.stashesVisible)
  const setStashesVisible = useWorkspaceStore(s => s.setStashesVisible)
  const filterVisible = useWorkspaceStore(s => s.filterVisible)
  const setFilterVisible = useWorkspaceStore(s => s.setFilterVisible)
  const banner = useWorkspaceStore(s => s.banner)
  const setBanner = useWorkspaceStore(s => s.setBanner)

  const rawRemotes = useAccountsStore(s => s.rawRemotes)
  const remoteErrors = useAccountsStore(s => s.remoteErrors)
  const accounts = useAccountsStore(s => s.accounts)

  const graphRows = useHistoryStore(s => s.graphRows)
  const graphDone = useHistoryStore(s => s.graphDone)
  const graphLoading = useHistoryStore(s => s.graphLoading)
  const localCommits = useHistoryStore(s => s.localCommits)
  const commitSha = useHistoryStore(s => s.commitSha)
  const setCommitSha = useHistoryStore(s => s.setCommitSha)
  const commitFiles = useHistoryStore(s => s.commitFiles)
  const commitFile = useHistoryStore(s => s.commitFile)
  const setCommitFile = useHistoryStore(s => s.setCommitFile)
  const commitDiff = useHistoryStore(s => s.commitDiff)
  const commitTokens = useHistoryStore(s => s.commitTokens)
  const historyFile = useHistoryStore(s => s.historyFile)
  const setHistoryFile = useHistoryStore(s => s.setHistoryFile)
  const fileCommits = useHistoryStore(s => s.fileCommits)
  const fileHistoryLoading = useHistoryStore(s => s.fileHistoryLoading)
  const fileHistoryError = useHistoryStore(s => s.fileHistoryError)
  const fileHistoryMore = useHistoryStore(s => s.fileHistoryMore)
  const fileHistoryLoadingMore = useHistoryStore(s => s.fileHistoryLoadingMore)
  const compared = useHistoryStore(s => s.compared)
  const setCompared = useHistoryStore(s => s.setCompared)
  const selectHistoryCommit = useHistoryStore(s => s.selectCommit)

  const isWindows = useIsWindows()
  const sidebarPanel = useRef<PanelImperativeHandle>(null)

  const repo = state?.selectedRepository ?? null
  const forcePushBranches = useRepositoryStore(s => (repo ? s.forcePushBranches[repo] : undefined))
  // Desktop getCurrentBranchForcePushState：推拉按钮、菜单与空白页建议共用
  const forcePushBranchState = getCurrentBranchForcePushState(status, forcePushBranches)
  const stateLoaded = state !== null
  const repositories = useMemo(() => state?.repositories ?? [], [state?.repositories])

  const registeredRepositoryPaths = state?.repositories
  const selectedRepositoryPath = state?.selectedRepository
  useEffect(() => {
    if (!registeredRepositoryPaths) return
    let active = true
    const runtime = getDesktopRuntime()
    void Promise.all(registeredRepositoryPaths.map(path => runtime.repositoriesStore.addRepository(path, undefined)))
      .then(repositories => {
        if (active)
          runtime.appStore.selectRepository(
            repositories.find(repository => repository.path === selectedRepositoryPath) ?? null
          )
      })
      .catch(error => log.error("Unable to synchronize repository stores", String(error)))
    return () => {
      active = false
    }
  }, [registeredRepositoryPaths, selectedRepositoryPath])

  useEffect(() => useRepositoryIndicatorsStore.getState().bind(), [])
  // Desktop BackgroundFetcher: the selected repository's periodic fetch shares the Git operation lock.
  useEffect(() => {
    const { appStore } = getDesktopRuntime()
    appStore.backgroundFetch = async repository => {
      const { status, runBackground } = useRepositoryStore.getState()
      if (repository.path !== activeRepository() || !status.remote) return
      const remote = status.remote
      // Desktop 只给关联上 GitHub 的仓库后台 fetch；GitLab 是一等平台，已登录的 GitLab 远端同样 fetch
      const { rawRemotes, accounts } = useAccountsStore.getState()
      const hosted = rawRemotes[repository.path]
      const gitlab = !!hosted && accounts[hosted.host]?.kind === "gitlab"
      if (!repository.gitHubRepository && !gitlab) return
      await runBackground(() => ipc.fetch(repository.path, remote))
    }
    return () => {
      appStore.backgroundFetch = null
    }
  }, [])

  useEffect(() => useAccountsStore.getState().loadRemotes(repositories), [repositories, rawRemotes, remoteErrors])

  // 远端挂到用户添加的实例：HTTPS 按 URL 取最长匹配的子路径实例，SSH 远端不带 Web 端口与子路径，
  // 按 Desktop 的 hostname 匹配。
  const remotes = useMemo(() => {
    const known = state?.accountHosts ?? []
    return Object.fromEntries(Object.entries(rawRemotes).map(([path, r]) => [path, r && accountRemoteFor(r, known)]))
  }, [rawRemotes, state?.accountHosts])

  // Desktop 选中仓库时就加载开放的 PR（分支下拉页签上的数量）；换远端时中断上一次请求
  const selectedRemote = repo ? (remotes[repo] ?? null) : null
  useEffect(() => usePullRequestsStore.getState().load(repo, selectedRemote), [repo, selectedRemote])
  const pullRequestCount = usePullRequestsStore(s => s.list.length)
  const pullRequestTarget = usePullRequestsStore(s => s.target)
  // Desktop currentPullRequest：当前分支对应的开放 PR（按 PR 检出的分支叫 pr/<号>）
  const currentPullRequest = usePullRequestsStore(s =>
    status.branch ? s.list.find(pr => pr.head === status.branch || status.branch === `pr/${pr.number}`) : undefined
  )

  const repoHosts = useMemo(
    () => [...new Set(Object.values(remotes).flatMap(r => (r ? [r.host] : [])))].toSorted(),
    [remotes]
  )

  // 云端条目要知道哪些已经克隆到本地了，键是 host/owner/name
  const clonedByRemote = useMemo(() => {
    const map = new Map<string, string>()
    for (const [path, r] of Object.entries(remotes)) {
      if (r) map.set(`${r.host}/${r.owner}/${r.name}`, path)
    }
    return map
  }, [remotes])

  // 要过问的实例：公有两家 + 仓库 origin 上出现过的 + 用户手动加的
  const accountHosts = useMemo(
    () => [...new Set(["github.com", "gitlab.com", ...repoHosts, ...(state?.accountHosts ?? [])])].toSorted(),
    [repoHosts, state?.accountHosts]
  )

  const refreshAccounts = useCallback(
    (refresh = false) =>
      useAccountsStore
        .getState()
        .refreshAccounts(accountHosts, refresh, host => showError(t("prefs.tokenRejectedNotice", { host }))),
    [accountHosts, t]
  )
  useEffect(() => refreshAccounts(), [refreshAccounts])

  // 启动时恢复上次的仓库、侧栏宽度和标签页
  useEffect(() => useAppStateStore.getState().load(), [])

  // 主题与语言跟随状态变化
  useEffect(() => {
    if (!state) return
    return applyTheme(state.theme)
  }, [state?.theme, state])

  // Desktop 在应用根节点设 underline-links 类与 tab-size；这里设在 html 上，弹层也算进去
  const underlineLinks = usePreferencesStore(s => s.underlineLinks)
  const tabSize = usePreferencesStore(s => s.tabSize)
  useEffect(() => {
    document.documentElement.classList.toggle("underline-links", underlineLinks)
    document.documentElement.style.tabSize = String(tabSize)
  }, [underlineLinks, tabSize])

  useEffect(() => {
    if (!state) return
    const want = state.language || (navigator.language.startsWith("zh") ? "zh-CN" : "en")
    if (i18n.language !== want) void i18n.changeLanguage(want)
  }, [state?.language, state])

  // 仓库一换，所有跟仓库绑定的选择态都得清掉——否则会拿上一个仓库的 sha 或路径去新仓库里查，
  // git 直接报 `fatal: bad object <上一个仓库的 sha>`。放在这里而不是 selectRepo 里：
  // 仓库也可能从别处换掉（启动时读存档、prune 掉死路径），写在调用点必然漏。
  // 清空必须先于绑定新仓库的刷新，否则新仓库的第一份状态会被清掉。
  useEffect(() => {
    useRepositoryStore.getState().reset()
    useChangesStore.getState().reset()
    useHistoryStore.getState().reset()
    return useRepositoryStore.getState().bind(repo)
  }, [repo])

  // Desktop keeps the current changed file selected while it exists, and
  // selects the first remaining file when opening or refreshing a repository.
  useEffect(() => {
    setSelected(current =>
      status.changes.some(file => file.path === current) ? current : (status.changes[0]?.path ?? null)
    )
  }, [status.changes, setSelected])

  // 外部改动（命令行提交、切分支、别的工具改文件）不会通知我们。两道保险：
  //   1. 后端的文件监听 —— 并排摆着用时窗口根本不会失去焦点，只靠焦点是不够的
  //   2. 窗口重新获得焦点 —— 监听没覆盖到的情况（比如仓库在网络盘上）兜底，
  //      原版就只有这一条（app-store 的 _setAppFocusState）
  useEffect(() => {
    const onFocus = () => void refresh()
    const onVisible = () => document.visibilityState === "visible" && void refresh()
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    const un = listen<string>("repo-changed", e => {
      // 事件在路上时可能已经切走了仓库，对一下再刷
      if (e.payload === repo) void refresh()
    })
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
      void un.then(f => f())
    }
  }, [refresh, repo])

  // 盯住当前仓库的文件变化；没有打开仓库时不盯
  useEffect(() => {
    if (!stateLoaded) return
    void ipc.watchRepo(repo).catch(error => log.warn("Unable to watch repository", error))
  }, [repo, stateLoaded])

  const currentRemote = remotes[repo ?? ""]
  useEffect(() => useRepositoryStore.getState().loadCompletions(repo, currentRemote), [repo, currentRemote])

  // 提交人：头像用它的首字母
  useEffect(() => useRepositoryStore.getState().loadAuthor(), [])

  // 切到 History 才拉提交图，避免打开仓库就白跑一次遍历。reloadKey 让命令行提交、压缩、变基之后
  // 列表跟着变，否则照着旧的几条再操作就会失败（实测：压缩一次后再压报「提交不在范围里」）。
  const historyTab = state?.selectedTab === "history"
  useEffect(() => {
    if (!repo || !historyTab) return
    return useHistoryStore.getState().loadGraph(repo)
  }, [repo, historyTab, reloadKey])

  // 没有上游的分支：Desktop refreshChangesSection / refreshHistorySection 每次刷新都 loadLocalCommits，
  // 没有上游时跑 `HEAD --not --remotes`（git-store.ts:624-629）。走 commit_details 的进程内 gix 路径，不按行查
  const needsLocalCommits = status.remote != null && !status.hasUpstream
  useEffect(
    () => useHistoryStore.getState().loadLocalCommits(historyTab ? repo : null, needsLocalCommits),
    [repo, historyTab, reloadKey, needsLocalCommits]
  )

  const loadMoreGraph = useCallback(() => {
    if (repo) useHistoryStore.getState().loadMoreGraph(repo)
  }, [repo])

  // 文件历史：跟 reloadKey 一起刷新，提交、变基之后列表才跟得上
  useEffect(() => useHistoryStore.getState().loadFileHistory(repo, historyFile), [repo, historyFile, reloadKey])

  const loadMoreFileHistory = useCallback(() => {
    if (repo) useHistoryStore.getState().loadMoreFileHistory(repo)
  }, [repo])

  const commits = useMemo(() => graphRows.map(row => row.commit), [graphRows])
  // 提交图从全部分支、标签和贮藏遍历；压缩、挪动、重排和「已推送」判断只看 HEAD 历史
  const headCommits = useMemo(() => headHistory(graphRows, commits), [graphRows, commits])
  const selectedCommitFile = useMemo(() => commitFiles.find(f => f.path === commitFile), [commitFiles, commitFile])
  const commitOldPath =
    selectedCommitFile && (selectedCommitFile.kind === "renamed" || selectedCommitFile.kind === "copied")
      ? selectedCommitFile.oldPath
      : null
  const commitFileKind = selectedCommitFile?.kind

  // 选中提交 → 拉它改了哪些文件；选中文件 → 拉它在那次提交里的 diff
  useEffect(() => useHistoryStore.getState().loadCommitFiles(repo, commitSha), [repo, commitSha])
  useEffect(
    () => useHistoryStore.getState().loadCommitDiff(repo, commitSha, commitFile, commitOldPath),
    [repo, commitSha, commitFile, commitOldPath]
  )

  const stateOf = useCallback(
    (path: string): FileState => files.get(path) ?? { include: DiffSelectionType.All, selection: null },
    [files]
  )

  // A second edit leaves the porcelain status unchanged. The watcher refresh
  // revision must also invalidate the selected diff and syntax tokens.
  // 换仓库的那次提交里，上面的 reset 已经清掉了选择与状态，而这次渲染拿到的 selected / status 还是旧仓库的：
  // 从 store 取当前值，旧仓库的文件不会拿去新仓库里起一次 git diff（取消只丢结果，后端进程照样跑完）
  useEffect(() => {
    const current = useChangesStore.getState()
    return current.loadDiff(repo, current.selected, useRepositoryStore.getState().status.changes)
  }, [repo, selected, status.changes, diffKey])

  /** 克隆：先让用户选父目录，仓库名从 URL 推出来。 */
  const doClone = async (url: string) => {
    const parent = await open({ directory: true, multiple: false })
    if (typeof parent !== "string" || !state) return
    const name = sanitizeCloneName(url)
    if (name === null) {
      showError(t("noRepos.invalidCloneName"))
      return
    }
    await cloneInto(url, `${parent}/${name}`, name)
  }
  /** Desktop _clone：失败时带上 RetryActionType.Clone，错误对话框给「重新克隆」 */
  const cloneInto = async (url: string, dest: string, name: string) => {
    if (!state) return
    await run(async () => {
      await ipc
        .cloneRepo(url, dest, {}, progress => showProgress(progress.description ?? progress.title))
        .catch((error: unknown) => {
          throw new ErrorWithMetadata(toPresentableError(error), {
            retryAction: { type: RetryActionType.Clone, name, url, path: dest, options: {} }
          })
        })
      setState(current =>
        current
          ? {
              ...current,
              selectedRepository: dest,
              repositories: [dest, ...current.repositories.filter(path => path !== dest)]
            }
          : current
      )
    })
  }

  const pickRepo = async () => {
    const dir = await open({ directory: true, multiple: false })
    if (typeof dir !== "string" || !state) return
    await run(async () => {
      const info = await ipc.repositoryType(dir)
      if (info.kind === "unsafe") {
        const trusted = await confirm(t("repositoryAccess.trustDescription", { path: info.path }), {
          title: t("repositoryAccess.trustTitle"),
          kind: "warning",
          okLabel: t("repositoryAccess.trust"),
          cancelLabel: t("common.cancel")
        })
        if (!trusted) return
        await ipc.addSafeDirectory(info.path)
      } else if (info.kind === "missing" || info.kind === "bare") {
        throw new Error(t(info.kind === "missing" ? "repositoryAccess.missing" : "repositoryAccess.bare"))
      }
      const root = await ipc.repositoryRoot(dir)
      patch({
        selectedRepository: root,
        repositories: [root, ...state.repositories.filter(r => r !== root)]
      })
      setSelected(null)
      setFiles(new Map())
    })
  }

  /** 新建仓库：选一个空目录，git init 之后直接打开。
   *  默认分支照 Desktop lib/helpers/default-branch.ts getDefaultBranch：全局 `init.defaultBranch`，
   *  没配就是 main；设置 › Git 里的「新仓库的默认分支名」写的就是它。 */
  const newRepo = async () => {
    const dir = await open({ directory: true, multiple: false })
    if (typeof dir !== "string" || !state) return
    await run(async () => {
      await ipc.initRepo(dir, (await getGlobalConfigValue("init.defaultBranch")) ?? "main")
      await ipc.writeGitAttributes(dir)
      patch({
        selectedRepository: dir,
        repositories: [dir, ...state.repositories.filter(r => r !== dir)]
      })
    })
  }

  /** 一切「打开什么」都走这里。加新视图只需在这张表里加一条，
   *  不用再去各个调用点补「记得把别的视图关掉」。 */
  const navigate = (uri: string) => {
    const target = parse(uri)
    if (!target) {
      console.warn(`不认识的地址: ${uri}`)
      return
    }
    if (target.host === "discover") {
      setCanvasPage(0)
      return
    }
    if (target.host !== "settings") setCanvasPage(1)
    switch (target.host) {
      case "repo": {
        const path = target.params.get("path")
        if (path) patch({ selectedRepository: path })
        setRoute({ kind: "repo" })
        break
      }
      case "inbox":
      case "mine":
      case "stars":
        setRoute({ kind: target.host })
        break
      case "settings":
        setPrefsOpen(true)
        break
      default:
        console.warn(`不认识的地址: ${uri}`)
    }
  }

  /** 进入文件历史模式：切到 History，左栏只列改过这个文件的提交 */
  const showFileHistory = (path: string) => {
    setHistoryFile(path)
    patch({ selectedTab: "history" })
  }
  // Desktop performPull: without a current remote the pull fails with "The repository has no remotes.";
  // fetching every remote of an empty list does nothing. A bare "origin" would be a relative path to Git.
  // Desktop _pull 的 onHookFailure：选了中止就当没拉，不报错
  /** Desktop pushPullFetchProgress：推送、拉取、获取从开始到刷新完，进度挂在推拉按钮上 */
  const setNetworkProgress = (path: string, progress: NetworkProgress | null) =>
    useRepositoryStore.getState().setNetworkProgress(path, progress)
  /** Desktop performPush / _pull / performFetch 收尾：快进其他分支（失败只记日志），刷新占最后 10%。
   *  刷新本身由 run 在操作之后做，进度保持到那时才清掉 */
  const refreshAfterNetworkOperation = async (path: string, refreshStartProgress: number) => {
    const title = t("toolbar.refreshingRepository")
    setNetworkProgress(path, {
      kind: "generic",
      title,
      description: t("toolbar.fastForwardingBranches"),
      value: refreshStartProgress
    })
    await ipc.fastForwardBranches(path).catch(error => log.error("Branch fast-forwarding failed", error))
    setNetworkProgress(path, { kind: "generic", title, value: refreshStartProgress + 0.1 * 0.5 })
  }
  const withNetworkProgress = async (path: string, operation: () => Promise<unknown>) => {
    try {
      await run(operation)
    } finally {
      setNetworkProgress(path, null)
    }
  }
  /** Desktop _pull：拉取约是获取的两倍时长，两者缩放到 0–0.9，最后 10% 留给刷新 */
  const doPull = (path: string) =>
    withNetworkProgress(path, async () => {
      const remote = useRepositoryStore.getState().status.remote
      if (!remote) throw new BranchWorkflowError("noRemotes")
      const scale = (1 / (2 + 1)) * (1 - 0.1)
      const pullWeight = 2 * scale
      const fetchWeight = 1 * scale
      const title = t("toolbar.pullingRemote", { remote })
      const { onHookFailure, ignoreAborted } = hookFailureHandling()
      setNetworkProgress(path, { kind: "pull", title, value: 0 })
      // Desktop performPull 用 performFailableOperation：拉取失败或在钩子处中止，照样快进其它分支、刷新，错误另行显示
      const failure = await ignoreAborted(
        pullRemote(
          { path },
          { name: remote },
          {
            onHookFailure,
            progressCallback: progress =>
              setNetworkProgress(path, { ...progress, title, value: progress.value * pullWeight })
          }
        ),
        undefined
      ).then(
        () => null,
        (error: unknown) => ({ error })
      )
      await refreshAfterNetworkOperation(path, pullWeight + fetchWeight)
      if (failure) withRetry(path, repository => ({ type: RetryActionType.Pull, repository }))(failure.error)
    })
  /** Desktop performFetch：获取占 0.9，刷新 0.1 */
  const doFetch = (path: string) =>
    withNetworkProgress(path, async () => {
      const remote = useRepositoryStore.getState().status.remote
      if (!remote) return
      const fetchWeight = 0.9
      const title = t("toolbar.fetchingRemote", { remote })
      // Desktop fetchRemotes 用 performFailableOperation：获取失败照样快进、刷新，错误另行显示
      const failure = await fetchRemote({ path }, { name: remote }, progress =>
        setNetworkProgress(path, { ...progress, title, value: progress.value * fetchWeight })
      ).then(
        () => null,
        (error: unknown) => ({ error })
      )
      await refreshAfterNetworkOperation(path, fetchWeight)
      if (failure) throw failure.error
    })
  /** Keep confirmation, transport and recovery inside one operation lock. */
  const confirmBranchStash = (name: string, current: string) => ask(t("branch.stashConfirm", { name, current }))

  /** Desktop StashAndSwitchBranch：切换前有更改时问放哪里。选了「留在当前分支」而这个分支已有贮藏时，
   *  原版会弹 ConfirmOverwriteStash —— checkoutWithStash 里接着问，这里只回答选择。 */
  const stashAndSwitchDispatcher = {
    showPopup: () => answerStashPrompt(true),
    checkoutBranch: async (repository: Repository, _branch: Branch, strategy?: UncommittedChangesStrategy) => {
      answerStashPrompt(strategy === UncommittedChangesStrategy.MoveToNewBranch ? "carry" : true)
      return repository
    }
  }
  // Desktop OverwriteStashedChanges
  const confirmOverwriteStash = () => ask(t("desktopUI.areYouSureYouWantToProceedThisWillOverwriteYourExistingStash"))
  const checkoutPrompts = {
    stashAndSwitch: promptStashAndSwitch,
    overwriteStash: confirmOverwriteStash
  }
  const checkoutStrategy = () => usePreferencesStore.getState().uncommittedChangesStrategy
  // Desktop createStashForCurrentBranch：这个分支已有贮藏时先确认覆盖，新的建好后丢掉旧的
  const doStashAll = async () => {
    const branch = status.branch
    if (!repo || !branch) return
    if ((await ipc.lastBranchStash(repo, branch)) && !(await confirmOverwriteStash())) return
    await run(() => createStashAndDropPreviousEntry(repo, branch, ipc))
  }
  const branchNamed = (name: string) => new Branch(name, null, { sha: "" }, BranchType.Local, `refs/heads/${name}`)
  const stashAndSwitchDialog = repo && stashPrompt && (
    <StashAndSwitchBranch
      repository={new Repository(repo, -1, null, false)}
      dispatcher={stashAndSwitchDispatcher}
      currentBranch={branchNamed(stashPrompt.current)}
      branchToCheckout={branchNamed(stashPrompt.name)}
      hasAssociatedStash={stashPrompt.hasAssociatedStash}
      onDismissed={() => answerStashPrompt(false)}
    />
  )

  const doPush = async (force = false) => {
    if (!repo) return
    // Desktop app-store performPush：仓库没有远端时不推送，改为打开「发布仓库」
    if (!force && useRepositoryStore.getState().status.remote === null) {
      setPublishing(true)
      return
    }
    // Desktop performPush：推送约是获取的 2.5 倍时长，推送与随后的获取缩放到 0–0.9，最后 10% 留给刷新
    const scale = (1 / (2.5 + 1)) * (1 - 0.1)
    const pushWeight = 2.5 * scale
    const fetchWeight = 1 * scale
    await withNetworkProgress(repo, async () => {
      // Desktop _push 的 onHookFailure：pre-push 失败时问；选了中止就到此为止，不报错
      const { onHookFailure, ignoreAborted } = hookFailureHandling()
      let pushedTo = null as string | null
      await ignoreAborted(
        pushWithRecovery(
          repo,
          force,
          {
            ...ipc,
            push: async (path, remote, branch, target, forceWithLease) => {
              const title = t("toolbar.pushingTo", { remote })
              setNetworkProgress(path, { kind: "push", title, value: 0 })
              // Desktop performPush：带上待推送的标签，推送成功后清空
              const { tagsToPush, clearTagsToPush } = useRepositoryStore.getState()
              // Desktop performPush 的 RetryActionType.Push：错误对话框标题「推送失败」
              await push(
                { path },
                { name: remote },
                branch,
                target,
                tagsToPush,
                { forceWithLease, onHookFailure },
                progress => setNetworkProgress(path, { ...progress, title, value: pushWeight * progress.value })
              ).catch(withRetry(path, repository => ({ type: RetryActionType.Push, repository })))
              clearTagsToPush(path)
              pushedTo = remote
            }
          },
          () => ask(t("push.needsPull")),
          () => ask(t("push.forceConfirm"), "confirmForcePush")
        ),
        undefined
      )
      if (pushedTo === null) return
      const title = t("toolbar.fetchingRemote", { remote: pushedTo })
      await fetchRemote({ path: repo }, { name: pushedTo }, progress =>
        setNetworkProgress(repo, { ...progress, title, value: pushWeight + progress.value * fetchWeight })
      )
      await refreshAfterNetworkOperation(repo, pushWeight + fetchWeight)
    })
  }

  // Desktop _undoCommit：有未提交改动时提示（可在「提示」里关掉）；撤销合并提交总是提示
  const doUndoCommit = async () => {
    if (!repo) return
    const head = graphRows.find(row => row.head != null)?.commit
    const clean = status.changes.length === 0
    if (head && head.parentCount > 1) {
      const lead = clean ? "" : `${t("desktopUI.youHaveChangesInProgressUndoingTheMergeCommit")}\n\n`
      const warning = `${lead}${t("desktopUI.undoingAMergeCommitWillApplyTheChanges")}\n\n${t("desktopUI.doYouWantToContinueAnyway")}`
      if (!(await ask(warning))) return
    } else if (!clean && !(await ask(t("desktopUI.youHaveChangesInProgressUndoingTheCommit"), "confirmUndoCommit")))
      return
    await run(() => ipc.undoCommit(repo))
  }

  const doCheckout = async (branch: string) => {
    if (!repo) return
    // Desktop _checkoutBranch 的 RetryActionType.Checkout 与 gitContext checkout
    const retry = withRetry(
      repo,
      repository => ({ type: RetryActionType.Checkout, repository, branch: branchNamed(branch) }),
      { gitContext: { kind: "checkout", branchToCheckout: branchNamed(branch) } }
    )
    await run(() => checkoutWithStash(repo, branch, ipc, checkoutPrompts, checkoutStrategy()).catch(retry))
  }

  /** Desktop _commitIncludedChanges / withIsCommitting：钩子进度与提交输出只属于这一次提交（改提交同样），
   *  HookFailed 里选了中止时返回 false 且不报错 */
  const commitWithHooks = async (commit: (callbacks: HookCallbackOptions) => Promise<void>) => {
    const { onHookFailure, ignoreAborted } = hookFailureHandling()
    const { setHookProgress, setSubscribeToCommitOutput } = useChangesStore.getState()
    setHookProgress(null)
    setSubscribeToCommitOutput(null)
    try {
      return await ignoreAborted(
        commit({
          onHookProgress: setHookProgress,
          onHookFailure,
          onTerminalOutputAvailable: setSubscribeToCommitOutput
        }).then(() => true),
        false
      )
    } finally {
      setHookProgress(null)
      setSubscribeToCommitOutput(null)
    }
  }

  const doCommit = async (summary: string, description: string, options: CommitOptions) => {
    if (!repo) return false
    return (
      (await run(async () => {
        // 超过 100MB 又没走 LFS 的文件，推上去会被 GitHub 拒——而那时提交已经在
        // 历史里了，得改历史才能救。提交前问一句便宜得多（原版同样的把关）。
        const included = status.changes.filter(c => stateOf(c.path).include !== DiffSelectionType.None).map(c => c.path)
        const big = await ipc.oversizedFiles(repo, included)
        if (big.length > 0 && !(await ask(t("changes.oversized", { files: big.join("、") })))) {
          return false
        }
        // 先把内存里的勾选状态一次性落到 index，再提交。
        // 没勾的也要报上去——它可能本来就在 index 里（比如 `git mv` 产生的重命名），
        // 漏掉的话「没勾」并不会阻止它进这次提交。
        await applySelection(
          repo,
          status.changes.map(c => {
            const st = stateOf(c.path)
            return { file: c, include: st.include, selection: st.selection, expectedDiff: st.diff }
          })
        )
        // Desktop commit 的 gitContext：错误对话框标题「提交失败」
        const committed = await commitWithHooks(callbacks =>
          ipc.commit(repo, summary, description, options, callbacks)
        ).catch((error: unknown) => {
          throw new ErrorWithMetadata(toPresentableError(error), {
            repository: new Repository(repo, -1, null, false),
            gitContext: { kind: "commit" }
          })
        })
        if (!committed) {
          return false
        }
        if (repo === activeRepository()) {
          setFiles(new Map())
          setSelected(null)
          setBanner(t("banner.committed", { summary }))
        }
        return true
      })) ?? false
    )
  }

  const cur = selected ? stateOf(selected) : null
  const selectedChange = status.changes.find(c => c.path === selected) ?? null

  /** 重写历史前问一句。
   *
   *  `oldest` 是这次会被重写到的最老那个提交的下标。它要是已经推出去了，
   *  措辞得更重——别人可能已经拉到过这些提交，改完他们那边会冲突。 */
  const confirmRewrite = async (oldest: number, what: string) => {
    const pushed = status.hasUpstream && oldest >= status.ahead
    return ask(t(pushed ? "history.rewritePushed" : "history.rewriteConfirm", { what }))
  }

  /** Desktop ProgressDialog 的标题 `${operation} in progress` */
  const multiCommitProgressTitle = (kind: MultiCommitOperationKind) =>
    ({
      [MultiCommitOperationKind.Rebase]: t("multiCommitOperation.rebaseInProgress"),
      [MultiCommitOperationKind.CherryPick]: t("multiCommitOperation.cherryPickInProgress"),
      [MultiCommitOperationKind.Squash]: t("multiCommitOperation.squashInProgress"),
      [MultiCommitOperationKind.Merge]: t("multiCommitOperation.mergeInProgress"),
      [MultiCommitOperationKind.Reorder]: t("multiCommitOperation.reorderInProgress")
    })[kind]
  /** Desktop dispatcher.performRetry：本应用接得住的几种 */
  const performRetry = (retryAction: RetryAction) => {
    switch (retryAction.type) {
      case RetryActionType.Push:
        return void doPush()
      case RetryActionType.Pull:
        return void doPull(retryAction.repository.path)
      case RetryActionType.Fetch:
        return void doFetch(retryAction.repository.path)
      case RetryActionType.Clone:
        return void cloneInto(retryAction.url, retryAction.path, retryAction.name)
      case RetryActionType.Checkout:
        return void doCheckout(retryAction.branch.name)
      case RetryActionType.Merge:
        return void doMerge(retryAction.theirBranch.name, false)
    }
  }
  /** Desktop createStashForCurrentBranch(repository, false)：当前分支已有贮藏或分离头时不建 */
  const createStashForCurrentBranch = async () => {
    const branch = useRepositoryStore.getState().status.branch
    if (!repo || !branch || desktopStashForBranch(stashList, branch) !== null) return false
    return (await run(() => ipc.stashPush(repo, branch).then(() => true))) ?? false
  }

  /** Desktop multiCommitOperation 的 ShowProgress：操作进行时显示进度对话框，结束（成功、冲突或出错）就关掉 */
  const withMultiCommitProgress = async <T,>(
    path: string,
    kind: MultiCommitOperationKind,
    operation: (onProgress: (progress: IMultiCommitOperationProgress) => void) => Promise<T>
  ) => {
    const { setMultiCommitOperation } = useRepositoryStore.getState()
    setMultiCommitOperation(path, { kind, progress: null })
    try {
      return await operation(progress => setMultiCommitOperation(path, { kind, progress }))
    } finally {
      setMultiCommitOperation(path, null)
    }
  }

  /** 修订、变基、压缩、重排：Desktop 在多提交操作完成（与修订提交后）把改写过的分支记进 forcePushBranches */
  const rewrite = async <T,>(operation: () => Promise<T>) => {
    const repository = repo
    const before = useRepositoryStore.getState().status.head
    const result = await run(operation)
    if (repository) useRepositoryStore.getState().settleRewrite(repository, before)
    return result
  }

  const doCherryPickMany = async (shas: string[]) => {
    if (!repo) return
    await run(async () => {
      const target = await askText(t("history.cherryPickTarget"), status.branch ?? "")
      if (!target) return
      await cherryPickToBranch(
        repo,
        target,
        shas,
        {
          ...ipc,
          cherryPick: (path, commits) =>
            withMultiCommitProgress(path, MultiCommitOperationKind.CherryPick, onProgress =>
              ipc.cherryPick(path, commits, showProgress, onProgress)
            )
        },
        confirmBranchStash
      )
    })
  }
  const doSquashMany = async (shas: string[]) => {
    if (!repo || shas.length < 2) return
    const chosen = headCommits.filter(c => shas.includes(c.sha))
    const target = chosen.at(-1)
    if (!target) return
    const oldest = headCommits.findIndex(c => c.sha === target.sha)
    if (!(await confirmRewrite(oldest, t("history.squashSelected")))) return
    await rewrite(() =>
      withMultiCommitProgress(repo, MultiCommitOperationKind.Squash, onProgress =>
        ipc.squashCommits(
          repo,
          chosen.slice(0, -1).map(c => c.sha),
          target.sha,
          headCommits[oldest + 1]?.sha ?? null,
          "",
          onProgress
        )
      )
    )
  }

  /** 把第 index 个提交压进它上一个（更老的那个）。 */
  const doSquashIntoParent = async (index: number) => {
    const c = headCommits[index]
    const parent = headCommits[index + 1]
    if (!repo || !c || !parent) return
    if (!(await confirmRewrite(index + 1, t("history.squashWhat", { a: c.summary, b: parent.summary })))) return
    // 不给信息 = 用 git 拼好的默认信息（两条摘要都留着）
    void rewrite(() =>
      withMultiCommitProgress(repo, MultiCommitOperationKind.Squash, onProgress =>
        ipc.squashCommits(repo, [c.sha], parent.sha, headCommits[index + 2]?.sha ?? null, "", onProgress)
      )
    )
  }

  /** 把第 from 条提交拖到第 to 条的位置上。
   *
   *  commits 是新的在前，所以「拖到第 to 条上面」= 让它排在 to 之前（更新的
   *  那一侧）。往更老的方向拖时落点是 to 本身；往更新的方向拖时，要落在 to
   *  的前一条之前，否则会停在原地。 */
  const doReorder = async (from: number, to: number) => {
    if (!repo) return
    const moving = headCommits[from]
    if (!moving || from === to) return
    // 目标位置对应的「排在谁之前」
    const beforeAt = from < to ? to : to - 1
    const before = headCommits[beforeAt] ?? null
    // 这次重写会碰到的最老那条：落点和原位置里更老的那个
    const oldest = Math.max(from, Math.max(0, beforeAt))
    if (!(await confirmRewrite(oldest, t("history.moveWhat", { a: moving.summary })))) return
    void rewrite(() =>
      withMultiCommitProgress(repo, MultiCommitOperationKind.Reorder, onProgress =>
        ipc.reorderCommits(repo, [moving.sha], before?.sha ?? null, headCommits[oldest + 1]?.sha ?? null, onProgress)
      )
    )
  }

  /** 把第 index 个提交和相邻的那个换位置。
   *
   *  commits 是新的在前。「往前挪」= 和更老的那个（下标更大）换位置，做法是
   *  把自己排到那个更老的之前；「往后挪」反过来，让更新的那个排到自己之前。 */
  const doMove = async (index: number, direction: "older" | "newer") => {
    if (!repo) return
    const movingAt = direction === "older" ? index : index - 1
    const beforeAt = direction === "older" ? index + 1 : index
    const moving = headCommits[movingAt]
    const before = headCommits[beforeAt]
    if (!moving || !before) return
    if (!(await confirmRewrite(beforeAt, t("history.moveWhat", { a: moving.summary })))) return
    void rewrite(() =>
      withMultiCommitProgress(repo, MultiCommitOperationKind.Reorder, onProgress =>
        ipc.reorderCommits(repo, [moving.sha], before.sha, headCommits[beforeAt + 1]?.sha ?? null, onProgress)
      )
    )
  }

  /** 合并分支。先在内存里试合一次，会撞车就把数目摆出来让用户决定——
   *  原来的流程是「点了合并 → 一堆冲突 → 现在怎么办」。 */
  const doMerge = async (name: string, squash: boolean) => {
    if (!repo) return
    const ours = status.branch
    if (ours) {
      try {
        const p = await ipc.mergePreview(repo, ours, name)
        if (p.unrelated) {
          showError(t("branch.unrelated", { name }))
          return
        }
        if (p.conflicts > 0 && !(await ask(t("branch.willConflict", { count: p.conflicts, name })))) {
          return
        }
      } catch {
        // 预览失败不该挡着合并本身，照常往下走
      }
    }
    // Desktop _mergeBranch：HookFailed 里选了中止就只刷新，不报错
    await run(() => {
      const { onHookFailure, ignoreAborted } = hookFailureHandling()
      // Desktop _mergeBranch 的 RetryActionType.Merge；它的重试按普通合并做，压缩合并不附，免得重试变成普通合并
      const merging = ipc.mergeBranch(repo, name, squash, { onHookFailure })
      return ignoreAborted(
        squash || !ours
          ? merging
          : merging.catch(
              withRetry(repo, repository => ({
                type: RetryActionType.Merge,
                repository,
                currentBranch: ours,
                theirBranch: branchNamed(name)
              }))
            ),
        undefined
      )
    })
  }

  const doDeleteBranch = async (name: string) => {
    if (!repo || !(await ask(t("branch.deleteConfirm", { name })))) return
    try {
      let checkout: string | null = null
      if (name === status.branch) {
        const branches = (await ipc.branchDetails(repo)).filter(b => !b.remote && b.name !== name)
        if (!branches.length) throw new Error(t("branch.lastBranch"))
        checkout = await askText(t("branch.switchBeforeDelete", { name }), branches[0].name)
        if (!checkout) return
        if (!branches.some(b => b.name === checkout)) throw new Error(t("branch.unknownBranch", { name: checkout }))
      }
      await run(async () => {
        if (checkout) await ipc.checkout(repo, checkout)
        await ipc.deleteBranch(repo, name)
      })
    } catch (e) {
      showError(e)
    }
  }

  /** 只丢弃 diff 里的某几行。整文件丢弃走废纸篓那条路，这里只改文件内容。 */
  const doDiscardLines = async (source: IRawDiff, lines: number[]) => {
    if (!repo || !selected || !diff || busy) return
    if (!(await ask(t("diff.discardConfirm", { count: lines.length })))) return
    await run(() => discardLines(repo, selected, source, lines))
  }
  // 对比列表、文件历史里的提交多半不在已翻到的那几页里，光在 commits 里找会落空
  const selectedCommit =
    [...commits, ...fileCommits, ...(compared?.ahead ?? []), ...(compared?.behind ?? [])].find(
      c => c.sha === commitSha
    ) ?? null

  const { editorName, appMenu, defaultBranch, hasCurrentPullRequest } = useNativeMenu({
    state,
    status,
    busy: busy || dialogBlocking,
    remote: remotes[repo ?? ""] ?? null,
    stashesVisible,
    filterVisible,
    hasStashes: stashList.length > 0,
    platform: accounts[remotes[repo ?? ""]?.host ?? ""]?.kind ?? "github"
  })

  // 菜单栏点击。做什么和快捷键/界面按钮共用同一套动作，菜单只发事件。
  const onMenu = useEffectEvent((payload: string) => {
    switch (payload) {
      case "preferences":
        openPreferences("accounts")
        break
      case "new-repository":
        void newRepo()
        break
      case "add-repository":
        void pickRepo()
        break
      case "clone-repository":
        void askText(t("noRepos.cloneUrl")).then(url => {
          if (url) return doClone(url)
        })
        break
      case "show-repository-settings":
        if (repo) useDialogsStore.getState().setRepositorySettingsOpen(true)
        break
      case "show-repository-list":
        document.querySelector<HTMLInputElement>(".rail-filter input")?.focus()
        break
      case "show-worktrees":
      case "create-worktree":
        if (repo) setWorktreesOpen(true)
        break
      case "rename-branch":
        if (repo && status.branch)
          void askText(t("branch.renameTo"), status.branch).then(to => {
            if (to && to !== status.branch) void run(() => ipc.renameBranch(repo, status.branch ?? "", to))
          })
        break
      case "delete-branch":
        if (status.branch) void doDeleteBranch(status.branch)
        break
      case "preview-pull-request":
        if (repo) setCreatingPr(true)
        break
      case "open-pull-request": {
        const remote = remotes[repo ?? ""]
        if (remote && repo)
          void (async () => {
            const target = await contributionRepository(repo, remote)
            const details = (await ipc.branchDetails(repo)).find(b => !b.remote && b.name === status.branch)
            const upstream = details?.upstreamRemoteName
            const sources = await ipc.remotes(repo)
            const sourceRemote =
              sources.find(([name]) => name === upstream) ?? sources.find(([name]) => name === "origin")
            const head = details?.upstreamWithoutRemote ?? status.branch
            const prs = await ipc.pullRequests(target.host, target.owner, target.name, true)
            for (const pr of prs.filter(pr => pr.head === head)) {
              const source = await ipc.pullRequestSource(target.host, target.owner, target.name, pr.number)
              if (
                sourceRemote &&
                sameHostedRepository(
                  await ipc.parseRemote(source.cloneUrl),
                  await ipc.parseRemote(await ipc.remotePushUrl(repo, sourceRemote[0]))
                )
              ) {
                await openUrl(pr.url)
                return
              }
            }
            setCreatingPr(true)
          })().catch(e => showError(e))
        break
      }
      case "go-to-commit-message":
        patch({ selectedTab: "changes" })
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>(".commit-message-component .summary input")?.focus()
        )
        break
      case "compare-to-branch":
        patch({ selectedTab: "history" })
        requestAnimationFrame(() => document.querySelector<HTMLSelectElement>(".history-compare")?.focus())
        break
      case "remove-repository":
        if (repo)
          void ask(t("rail.removeConfirm"), "confirmRepoRemoval").then(ok => {
            if (!ok || !state) return
            const remaining = state.repositories.filter(path => path !== repo)
            patch({ repositories: remaining, selectedRepository: remaining[0] ?? null })
          })
        break
      case "discard-all-changes":
        if (repo)
          void ask(t("changes.discardAllConfirm"), "confirmDiscardChanges").then(ok => {
            if (ok) return run(() => ipc.discardChanges(repo, status.changes))
          })
        break
      case "update-branch-with-contribution-target-branch":
        if (repo)
          void run(async () => {
            const remotes = await ipc.remotes(repo)
            // Desktop findContributionTargetDefaultBranch：只有为上游贡献时才用 upstream 的默认分支
            const upstream = (await contributesToParent(repo))
              ? remotes.find(([name]) => name === "upstream")?.[0]
              : undefined
            const remote = upstream ?? status.remote ?? remotes[0]?.[0]
            if (!remote) throw new Error(t("prefs.noRemoteHint"))
            await ipc.fetch(repo, remote)
            const branch = await getRemoteHEAD(new Repository(repo, -1, null, false), remote)
            if (!branch) throw new Error(t("branch.noRemoteDefault"))
            const { onHookFailure, ignoreAborted } = hookFailureHandling()
            await ignoreAborted(
              ipc.mergeBranch(repo, `refs/remotes/${remote}/${branch}`, false, { onHookFailure }),
              undefined
            )
          })
        break
      case "open-with-external-editor":
        openPreferences("integrations")
        break
      case "branch-on-github":
      case "compare-on-github":
      case "create-issue-in-repository-on-github": {
        const hosted = remotes[repo ?? ""]
        if (hosted && repo)
          void (async () => {
            // Desktop getGitHubHtmlUrl：Issue 建在贡献目标上；分支和比较看的是自己的远端
            const remote =
              payload === "create-issue-in-repository-on-github" ? await contributionRepository(repo, hosted) : hosted
            const root = `https://${remote.host}/${remote.owner}/${remote.name}`
            const gitlab = accounts[remote.host]?.kind === "gitlab"
            const suffix =
              payload === "create-issue-in-repository-on-github"
                ? gitlab
                  ? "/-/issues/new"
                  : "/issues/new"
                : payload === "branch-on-github"
                  ? `${gitlab ? "/-" : ""}/tree/${encodeURIComponent(status.branch ?? "HEAD")}`
                  : `${gitlab ? "/-" : ""}/compare`
            await openUrl(root + suffix)
          })().catch(e => showError(e))
        break
      }
      case "show-changes":
        patch({ selectedTab: "changes" })
        break
      case "show-history":
        patch({ selectedTab: "history" })
        break
      // show-prs：分支下拉自己监听，打开「Pull Requests」页签
      case "discover":
        navigate(routes.discover())
        break
      case "select-all": {
        const active = document.activeElement
        // Desktop lets the focused component consume select-all before text fallback.
        if (active && !active.dispatchEvent(new CustomEvent("select-all", { bubbles: true, cancelable: true }))) break
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.select()
        else if (active instanceof HTMLElement && active.isContentEditable) document.execCommand("selectAll")
        else {
          const viewport = active?.closest(".side-by-side-diff-container, .gitcub-diff")
          if (viewport) document.getSelection()?.selectAllChildren(viewport)
        }
        break
      }
      case "increase-active-resizable-width":
      case "decrease-active-resizable-width":
        if (document.activeElement?.closest(".repository-sidebar") && sidebarPanel.current)
          sidebarPanel.current.resize(
            sidebarPanel.current.getSize().inPixels + (payload === "increase-active-resizable-width" ? 5 : -5)
          )
        // Desktop resizeActiveResizable：从焦点元素冒泡，工具栏按钮外的 Resizable 接住
        else document.activeElement?.dispatchEvent(new CustomEvent(payload, { bubbles: true, cancelable: true }))
        break
      case "toggle-changes-filter":
        patch({ selectedTab: "changes" })
        setFilterVisible(value => !value)
        break
      case "show-stashed-changes":
      case "hide-stashed-changes":
        patch({ selectedTab: "changes" })
        setStashesVisible(payload === "show-stashed-changes")
        break
      case "force-push":
        void doPush(true)
        break
      case "push":
        void doPush()
        break
      case "pull":
        if (repo) void doPull(repo)
        break
      case "fetch":
        if (repo) void doFetch(repo)
        break
      case "open-in-editor":
        if (repo) void ipc.openInEditor(repo)
        break
      case "open-in-terminal":
        if (repo) void ipc.openInTerminal(repo)
        break
      case "reveal":
        if (repo) void ipc.revealInFileManager(repo)
        break
      case "view-on-remote": {
        const hosted = remotes[repo ?? ""]
        // Desktop getGitHubHtmlUrl：fork 为上游贡献时打开上游
        if (hosted && repo)
          void contributionRepository(repo, hosted)
            .then(r => openUrl(`https://${r.host}/${r.owner}/${r.name}`))
            .catch(e => showError(e))
        break
      }
      case "stash-all-changes":
        void doStashAll()
        break
      case "undo-commit":
        void doUndoCommit()
        break
      case "show-branches-list":
        document.querySelector<HTMLElement>(".branch-button button")?.click()
        break
      default:
        break
    }
  })
  useEffect(() => {
    const un = listen<string>("menu", e => onMenu(e.payload))
    return () => void un.then(f => f())
  }, [])

  // 快捷键。键位照原版，一个不改——从 Desktop 过来的人肌肉记忆是现成的。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      handleShortcut(e, {
        // ⌘3 原先切到侧栏的 PR 页签；PR 列表搬进分支下拉后，改为打开下拉的「Pull Requests」页签
        onTab: tab => (tab === "pr" ? void emit("menu", "show-prs") : patch({ selectedTab: tab })),
        onFocusRepoSearch: () => document.querySelector<HTMLInputElement>(".rail-filter input")?.focus(),
        onOpenBranches: () => document.querySelector<HTMLElement>('[data-slot="popover-trigger"]')?.click(),
        onFocusSummary: () =>
          document.querySelector<HTMLInputElement>(".commit-message-component .summary input")?.focus(),
        onPush: () => void doPush(),
        onPull: () => repo && void doPull(repo),
        onFetch: () => repo && void doFetch(repo),
        onPreferences: () => setPrefsOpen(true)
      })
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  if (!state) return null

  // 所有「确定吗」都走这一个框：ask() 把 resolve 存起来，点了哪个按钮就
  // 回哪个答案。消息里带换行，按原样排版。
  const askDialog = asking && (
    <AlertDialog
      open
      onOpenChange={o => {
        if (!o) {
          answer(false)
        }
      }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("common.confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">{asking.message}</AlertDialogDescription>
        </AlertDialogHeader>
        {asking.prompt && (
          <Label className="font-normal">
            <Checkbox
              checked={asking.dontAskAgain}
              onCheckedChange={checked => useDialogsStore.getState().setDontAskAgain(checked)}
            />
            {t("desktopUI.doNotShowThisMessageAgain")}
          </Label>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              answer(false)
            }}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              answer(true)
            }}>
            {t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  // 要填字的那个框（标签名、新分支名）
  const askTextDialog = askingText && (
    <AlertDialog
      open
      onOpenChange={o => {
        if (!o) {
          answerText(null)
        }
      }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{askingText.message}</AlertDialogTitle>
        </AlertDialogHeader>
        <Input
          autoFocus
          value={askingText.value}
          onChange={e => setAskingTextValue(e.target.value)}
          onKeyDown={e => {
            // 回车即确定——填个名字还要伸手去点按钮太笨
            if (e.key === "Enter" && askingText.value.trim()) {
              answerText(askingText.value.trim())
            }
          }}
        />
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              answerText(null)
            }}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={!askingText.value.trim()}
            onClick={() => {
              answerText(askingText.value.trim())
            }}>
            {t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  const selectedPaths =
    fileSelection.repo === repo && fileSelection.anchor === selected
      ? fileSelection.paths.filter(path => status.changes.some(file => file.path === path))
      : selected
        ? [selected]
        : []

  // 丢弃是不可逆的，照原版走一次确认
  const discardDialog = discarding && (
    <AlertDialog open onOpenChange={o => !o && setDiscarding(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("changes.discardTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("changes.discardBody", { path: discarding.join(", ") })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const paths = discarding
              setDiscarding(null)
              if (!repo || !paths.length) return
              const changes = status.changes.filter(c => paths.includes(c.path))
              if (!changes.length) return
              void run(() => ipc.discardChanges(repo, changes)).then(() => {
                if (selected && paths.includes(selected)) setSelected(null)
                setFileSelection({ repo, anchor: null, paths: [] })
                // 没有「撤销」按钮：macOS 上没法程序化地从废纸篓捞回来
                // （trash 那个 crate 的 restore 不支持 macOS）。
                // 但至少得说清楚东西去哪了。
                setBanner(t("banner.discarded", { path: paths.join(", ") }))
              })
            }}>
            {t("changes.discard")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  const prefs = (
    <Preferences
      open={prefsOpen}
      onOpenChange={open => {
        setPrefsOpen(open)
        if (!open) void refresh()
      }}
      state={state}
      onPatch={patch}
      hosts={accountHosts}
      accounts={accounts}
      onAccountsChanged={() => refreshAccounts(true)}
      initialTab={prefsTab}
    />
  )

  // Desktop 在无仓库状态下 renderToolbar() 直接返回 null：
  // 没有工具栏，也没有左右分栏，整个窗口就是这一页。
  if (!repo) {
    return (
      <TooltipProvider>
        <div className="h-screen">
          <TitleBar />
          {prefs}
          {askDialog}
          {askTextDialog}
          {errors[0] && (
            <AppError
              key="app-error"
              error={errors[0]}
              onDismissed={() => clearError(errors[0]!)}
              onShowPreferences={() => openPreferences()}
              onRetryAction={performRetry}
            />
          )}
          <NoRepositoriesView
            repositories={state.repositories}
            onSelect={r => navigate(routes.repo(r))}
            onAdd={() => void pickRepo()}
            onClone={doClone}
          />
        </div>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      {/* 顶层就是左右两栏。工具栏的左半在左栏内部、右半在右栏内部——
          两栏的头同色同高，看起来是连续的一条深色工具栏，但仓库下拉
          和侧栏属于同一个面板，拖动分隔线时天然对齐。 */}
      {prefs}
      {askDialog}
      {askTextDialog}
      {stashAndSwitchDialog}
      {localChangesOverwritten && (
        <LocalChangesOverwrittenDialog
          key="local-changes-overwritten"
          hasExistingStash={desktopStashForBranch(stashList, status.branch) !== null}
          retryAction={localChangesOverwritten.retryAction}
          files={localChangesOverwritten.files}
          onDismissed={dismissLocalChangesOverwritten}
          onCreateStash={createStashForCurrentBranch}
          onRetry={performRetry}
        />
      )}
      {errors[0] && (
        <AppError
          key="app-error"
          error={errors[0]}
          onDismissed={() => clearError(errors[0]!)}
          onShowPreferences={() => openPreferences()}
          onRetryAction={performRetry}
        />
      )}
      {multiCommitOperation?.progress && (
        <ProgressDialog
          title={multiCommitProgressTitle(multiCommitOperation.kind)}
          progress={multiCommitOperation.progress}
          emoji={noEmoji}
        />
      )}
      {hookFailed && (
        <HookFailed
          key="hook-failure-dialog"
          hookName={hookFailed.hookName}
          terminalOutput={hookFailed.terminalOutput}
          resolve={hookFailed.resolve}
          onDismissed={dismissHookFailed}
        />
      )}
      {commitProgress && (
        <CommitProgress
          key="commit-progress-dialog"
          subscribeToCommitOutput={commitProgress}
          onDismissed={() => setCommitProgress(null)}
        />
      )}
      {repo && repositorySettingsOpen && (
        <RepositorySettings
          key={repo}
          repo={repo}
          primaryRemote={status.remote}
          hosted={remotes[repo] ?? null}
          onDismissed={() => {
            useDialogsStore.getState().setRepositorySettingsOpen(false)
            // 远端、身份、fork 行为可能变了：和关设置一样整体刷新，PR 列表按新的贡献目标重取
            void refresh()
            usePullRequestsStore.getState().refresh()
          }}
          onPublish={() => {
            useDialogsStore.getState().setRepositorySettingsOpen(false)
            setPublishing(true)
          }}
        />
      )}
      {repo && worktreesOpen && (
        <Worktrees
          key={repo}
          repo={repo}
          onClose={() => setWorktreesOpen(false)}
          onOpen={path => {
            patch({ repositories: [path, ...state.repositories.filter(r => r !== path)] })
            navigate(routes.repo(path))
          }}
          onMove={(oldPath, newPath) => {
            // Desktop _moveWorktree: a renamed worktree keeps its place in the list and,
            // when it is the selected repository, the selection follows the new path.
            patch({ repositories: state.repositories.map(r => (r === oldPath ? newPath : r)) })
            if (repo === oldPath) navigate(routes.repo(newPath))
          }}
        />
      )}
      {discardDialog}
      {repo && (
        <PublishRepository
          open={publishing}
          onOpenChange={setPublishing}
          repo={repo}
          branch={status.branch}
          hosts={Object.entries(accounts)
            .filter(([, a]) => a.login && !a.ignored)
            .map(([h]) => h)}
          onPublished={() => {
            void refresh()
          }}
        />
      )}
      {repo && (
        <CreatePullRequest
          open={creatingPr}
          onOpenChange={setCreatingPr}
          repo={repo}
          remote={remotes[repo] ?? null}
          branch={status.branch}
          onPushed={() => void refresh()}
        />
      )}
      {/* Windows 是 frame:false，自绘按钮和缩放边框都在这条里；
          macOS 的红绿灯由画布顶部工具栏让位。 */}
      {isWindows && <TitleBar />}
      {/* 右侧浮板保留常驻仓库列表与当前工作区，切换画布不卸载。 */}
      <FloatingWorkspace
        page={canvasPage}
        onPageChange={setCanvasPage}
        trackpadEnabled={state.canvasTrackpadGestures ?? false}
        navigation={
          <RepositoryRail
            repositories={state.repositories}
            remotes={remotes}
            remoteErrors={remoteErrors}
            accounts={accounts}
            current={repo}
            onAdd={() => void pickRepo()}
            onNewRepo={() => void newRepo()}
            author={author}
            route={route}
            trendingActive={canvasPage === 0}
            onNavigate={navigate}
            onSyncUpstream={r => {
              const m = remotes[r]
              if (!m) return
              void run(async () => {
                const upstream = await ipc.upstreamOf(m.host, m.owner, m.name)
                if (!upstream) {
                  showError(t("rail.notAFork"))
                  return
                }
                await ipc.syncUpstream(r, `https://${m.host}/${upstream}.git`, status.branch ?? "main")
              })
            }}
            ownership={state.repoOwnership}
            onOwnershipChange={(r, value) => {
              const next = { ...state.repoOwnership }
              // null = 回到自动判定，所以是删掉这条修正，而不是写一个默认值进去
              if (value === null) delete next[r]
              else next[r] = value
              patch({ repoOwnership: next })
            }}
          />
        }>
        <div className="repository-content flex min-w-0 flex-1 flex-col">
          {route.kind === "inbox" ? (
            <Inbox
              repositories={state.repositories}
              hosts={Object.entries(accounts)
                .filter(([, a]) => a.login && !a.ignored)
                .map(([h]) => h)}
              onOpenRepo={r => navigate(routes.repo(r))}
            />
          ) : route.kind !== "repo" ? (
            <Discover
              route={route}
              onNavigate={navigate}
              hosts={accountHosts}
              cloned={clonedByRemote}
              onOpen={path => navigate(routes.repo(path))}
              onCloned={path => {
                // 克隆完直接把它加进列表并打开——这才是「发现」的目的
                patch({ repositories: [path, ...state.repositories.filter(r => r !== path)] })
                navigate(routes.repo(path))
              }}
            />
          ) : (
            <>
              <ToolbarRight
                repo={repo}
                status={status}
                busy={busy}
                forcePushBranchState={forcePushBranchState}
                hostedPlatform={
                  selectedRemote ? (accounts[selectedRemote.host]?.kind === "gitlab" ? "GitLab" : "GitHub") : null
                }
                onCheckout={b => doCheckout(b)}
                onCreateBranch={(name, startPoint, noTrack) =>
                  run(async () => {
                    await ipc.createBranch(repo, name, startPoint, noTrack)
                    await ipc.checkout(repo, name)
                  })
                }
                onDeleteBranch={doDeleteBranch}
                onMergeBranch={(name, squash) => doMerge(name, squash)}
                onRebaseBranch={name =>
                  rewrite(() =>
                    withMultiCommitProgress(repo, MultiCommitOperationKind.Rebase, onProgress =>
                      ipc.rebaseBranch(repo, name, showProgress, onProgress)
                    )
                  )
                }
                onRenameBranch={from => {
                  void askText(t("branch.renameTo"), from).then(to => {
                    if (to && to !== from) void run(() => ipc.renameBranch(repo, from, to))
                  })
                }}
                // 凭据由后端自己找（设置里的令牌 → git 凭据助手 → gh/glab），
                // 前端不碰令牌，也不需要先判断「配没配」
                onPush={() => void doPush()}
                onPull={() => void doPull(repo)}
                onFetch={() => void doFetch(repo)}
                onForcePush={() => void doPush(true)}
                onWorktrees={() => setWorktreesOpen(true)}
                onOpenWorktree={path => {
                  patch({ repositories: [path, ...state.repositories.filter(r => r !== path)] })
                  navigate(routes.repo(path))
                }}
                // Desktop 把 PR 列表放在分支下拉的「Pull Requests」页签里；只有托管远端才有
                pullRequestCount={pullRequestCount}
                pullRequestBadge={
                  currentPullRequest &&
                  pullRequestTarget && <PullRequestBadge request={currentPullRequest} remote={pullRequestTarget} />
                }
                renderPullRequests={
                  remotes[repo ?? ""]
                    ? ({ close, isOnDefaultBranch, onCreateBranch }) => (
                        <PullRequests
                          repo={repo}
                          onCherryPick={(request, remote, shas) => {
                            void run(async () => {
                              const source = await ipc.pullRequestSource(
                                remote.host,
                                remote.owner,
                                remote.name,
                                request.number
                              )
                              try {
                                await cherryPickToPullRequest(
                                  repo,
                                  source,
                                  shas,
                                  {
                                    ...ipc,
                                    cherryPick: (path, commits) =>
                                      withMultiCommitProgress(path, MultiCommitOperationKind.CherryPick, onProgress =>
                                        ipc.cherryPick(path, commits, showProgress, onProgress)
                                      )
                                  },
                                  (name, current) => ask(t("branch.stashConfirm", { name, current })),
                                  source.kind === "gitlab" ? "mr" : "pr"
                                )
                              } finally {
                                close()
                              }
                            })
                          }}
                          remote={remotes[repo ?? ""] ?? null}
                          isOnDefaultBranch={isOnDefaultBranch}
                          onCreateBranch={onCreateBranch}
                          onCheckout={(request, remote) => {
                            if (!remote || busy) return
                            close()
                            void run(async () => {
                              const source = await ipc.pullRequestSource(
                                remote.host,
                                remote.owner,
                                remote.name,
                                request.number
                              )
                              const branch = await findPullRequestBranch(
                                repo,
                                source,
                                ipc,
                                source.kind === "gitlab" ? "mr" : "pr"
                              )
                              await checkoutWithStash(repo, branch, ipc, checkoutPrompts, checkoutStrategy())
                            })
                          }}
                          onCreate={() => {
                            close()
                            setCreatingPr(true)
                          }}
                        />
                      )
                    : undefined
                }
              />

              {(error || diffError) && <InlineError error={(error ?? diffError)!} />}

              <RepositorySplit
                panelRef={sidebarPanel}
                initialWidth={initialWidth ?? 250}
                onResize={width => patch({ sidebarWidth: width })}
                sidebar={
                  <div className="repository-sidebar">
                    <Tabs
                      // 旧版本存下的 "pr" 页签已不存在
                      value={state.selectedTab === "pr" ? "changes" : state.selectedTab}
                      onValueChange={v => patch({ selectedTab: v })}
                      className="flex min-h-0 flex-1 flex-col gap-0">
                      <TabsList variant="line" className="w-full shrink-0">
                        <TabsTrigger value="changes">
                          {t("tabs.changes")}
                          {status.changes.length > 0 && (
                            <span className="bg-muted-foreground/20 rounded-full px-1.5 text-[10px]">
                              {status.changes.length}
                            </span>
                          )}
                        </TabsTrigger>
                        <TabsTrigger value="history">{t("tabs.history")}</TabsTrigger>
                      </TabsList>

                      <TabsContent value="changes" className="panel">
                        {/* 没配身份的话提交会挂在一个默认的 name/email 上（或者 git
                    直接拒绝提交）。这是第一次用时最容易卡住的地方。 */}
                        {author !== undefined && (!author.name || !author.email) && (
                          <Banner
                            sticky
                            warning
                            message={t("identity.missing")}
                            actionLabel={t("identity.configure")}
                            onAction={() => setPrefsOpen(true)}
                            onDismiss={() => setAuthor({ name: "-", email: "-" })}
                          />
                        )}
                        {/* LFS 没生效是个会毁数据的状态，排在普通提示之前 */}
                        {lfs?.used && !lfs.installed && (
                          <Banner
                            sticky
                            warning
                            message={t(lfs.available ? "lfs.notInstalled" : "lfs.missing")}
                            actionLabel={lfs.available ? t("lfs.install") : undefined}
                            onAction={lfs.available && repo ? () => void run(() => ipc.lfsInstall(repo)) : undefined}
                            onDismiss={() => setLfs(null)}
                          />
                        )}
                        {banner && (
                          <span role="status" className="sr-only">
                            {banner}
                          </span>
                        )}
                        <Conflicts
                          operation={status.operation}
                          busy={busy}
                          files={status.changes.filter(c => c.change === "conflicted")}
                          ours={status.branch}
                          theirs={status.theirs}
                          onResolve={(file, keep) => void run(() => ipc.resolveConflict(repo, file.path, keep))}
                          // 中止和收尾都按「正在进行的是哪个操作」来，不靠试错
                          onAbort={op =>
                            void run(() => ipc.abortOperation(repo, op)).then(() =>
                              useRepositoryStore.getState().dropRewrite(repo)
                            )
                          }
                          onContinue={op =>
                            void run(() => {
                              // Desktop base-rebase / cherry-pick onContinue：继续时切回进度对话框
                              const kind =
                                op === "rebase"
                                  ? (useRepositoryStore.getState().rebaseKinds[repo] ?? MultiCommitOperationKind.Rebase)
                                  : op === "cherry-pick"
                                    ? MultiCommitOperationKind.CherryPick
                                    : null
                              return kind === null
                                ? ipc.continueOperation(repo, op)
                                : withMultiCommitProgress(repo, kind, onProgress =>
                                    ipc.continueOperation(repo, op, onProgress)
                                  )
                            }).then(() => useRepositoryStore.getState().settleRewrite(repo))
                          }
                        />
                        {stashesVisible && (
                          <Stashes
                            stashes={stashList}
                            onPop={name => void run(() => ipc.stashPop(repo, name))}
                            onDrop={name =>
                              void ask(
                                t("desktopUI.areYouSureYouWantToDiscardTheseStashedChanges"),
                                "confirmDiscardStash"
                              ).then(ok => {
                                if (ok) return run(() => ipc.stashDrop(repo, name))
                              })
                            }
                          />
                        )}
                        <ChangesSidebar
                          filterVisible={filterVisible}
                          key={repo}
                          repo={repo}
                          selectionOf={path => stateOf(path).selection}
                          changes={status.changes}
                          branch={status.branch}
                          selected={selected}
                          includeOf={p => stateOf(p).include}
                          selectedPaths={selectedPaths}
                          onSelectionChange={paths => {
                            const anchor = paths.at(-1) ?? null
                            setFileSelection({ repo, anchor, paths })
                            setSelected(anchor)
                          }}
                          onDiscardMany={setDiscarding}
                          onSelect={setSelected}
                          onIncludeChange={(path, include) =>
                            setFiles(prev => {
                              const c = prev.get(path)
                              return new Map(prev).set(path, {
                                include: include ? DiffSelectionType.All : DiffSelectionType.None,
                                diff: c?.diff,
                                selection:
                                  (include ? c?.selection?.withSelectAll() : c?.selection?.withSelectNone()) ?? null
                              })
                            })
                          }
                          onToggleAll={include =>
                            setFiles(prev => {
                              const next = new Map(prev)
                              for (const c of status.changes) {
                                const st = next.get(c.path)
                                next.set(c.path, {
                                  include: include ? DiffSelectionType.All : DiffSelectionType.None,
                                  diff: st?.diff,
                                  selection:
                                    (include ? st?.selection?.withSelectAll() : st?.selection?.withSelectNone()) ?? null
                                })
                              }
                              return next
                            })
                          }
                          author={author}
                          issues={issues}
                          mentionables={mentionables}
                          remote={currentRemote ?? null}
                          onDiscard={path => setDiscarding([path])}
                          // Desktop _appendIgnoreFile / _appendIgnoreRule：写完 .gitignore 后刷新仓库
                          onIgnore={(kind, patterns) =>
                            void run(() =>
                              kind === "files"
                                ? ipc.appendIgnoreFiles(repo, patterns)
                                : ipc.appendIgnoreRules(repo, patterns)
                            )
                          }
                          rebaseConflict={status.operation === "rebase"}
                          externalEditorLabel={editorName}
                          onBlame={path => setBlaming(path)}
                          onShowHistory={showFileHistory}
                          onCommit={doCommit}
                          onStashAll={() => void doStashAll()}
                          onUndoCommit={() => void doUndoCommit()}
                          onAmend={async (summary, description) => {
                            return (
                              (await rewrite(async () => {
                                await applySelection(
                                  repo,
                                  status.changes.map(file => ({
                                    file,
                                    include: stateOf(file.path).include,
                                    selection: stateOf(file.path).selection
                                  }))
                                )
                                return commitWithHooks(callbacks =>
                                  ipc.amendCommit(repo, summary, description, callbacks)
                                )
                              })) ?? false
                            )
                          }}
                        />
                      </TabsContent>

                      <TabsContent value="history" keepMounted className="panel data-[hidden]:hidden">
                        <HistorySidebar
                          commits={commits}
                          repo={repo}
                          fileHistory={
                            historyFile
                              ? {
                                  path: historyFile,
                                  commits: fileCommits,
                                  hasMore: fileHistoryMore,
                                  loadingMore: fileHistoryLoadingMore,
                                  onLoadMore: loadMoreFileHistory,
                                  loading: fileHistoryLoading,
                                  error: fileHistoryError
                                }
                              : null
                          }
                          onCloseFileHistory={() => setHistoryFile(null)}
                          rows={graphRows}
                          hasMore={!graphDone}
                          loadingMore={graphLoading}
                          onLoadMore={loadMoreGraph}
                          selected={commitSha}
                          onSelect={selectHistoryCommit}
                          onRevert={sha => {
                            const c = commits.find(x => x.sha === sha)
                            void run(() => ipc.revertCommit(repo, sha, (c?.parentCount ?? 1) > 1))
                          }}
                          onCherryPick={sha => void doCherryPickMany([sha])}
                          onCherryPickMany={shas => void doCherryPickMany(shas)}
                          onSquashMany={shas => void doSquashMany(shas)}
                          onCreateTag={sha => {
                            void askText(t("history.tagName")).then(name => {
                              if (!name) return
                              void run(async () => {
                                await ipc.createTag(repo, name, sha)
                                useRepositoryStore.getState().addTagToPush(repo, name)
                              })
                            })
                          }}
                          currentBranch={status.branch}
                          pushStatus={status}
                          localCommits={localCommits}
                          onMerge={b => doMerge(b, false)}
                          onCompared={setCompared}
                          onSquashIntoParent={i => void doSquashIntoParent(i)}
                          onMove={(i, d) => void doMove(i, d)}
                          onReorder={(from, to) => void doReorder(from, to)}
                          onResetTo={sha => {
                            // 重置会丢提交，问清楚要哪种：保留改动还是连改动一起丢
                            void ask(t("history.resetKeepChanges")).then(keep =>
                              run(() => ipc.resetTo(repo, keep ? "mixed" : "hard", sha))
                            )
                          }}
                          onOpenInBrowser={
                            remotes[repo ?? ""]
                              ? sha => {
                                  const r = remotes[repo ?? ""]
                                  if (r) void openUrl(`https://${r.host}/${r.owner}/${r.name}/commit/${sha}`)
                                }
                              : undefined
                          }
                        />
                      </TabsContent>
                    </Tabs>
                  </div>
                }>
                <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
                  {/* 逐行追溯占的是 diff 的位置：同一个文件，要么看改了什么，
                    要么看每行是谁改的，不会同时想看 */}
                  {blaming && repo ? (
                    <Blame
                      repo={repo}
                      file={blaming}
                      onClose={() => setBlaming(null)}
                      onSelectCommit={sha => {
                        setBlaming(null)
                        patch({ selectedTab: "history" })
                        setCommitSha(sha)
                      }}
                    />
                  ) : state.selectedTab === "history" ? (
                    selectedCommit ? (
                      <CommitDetails
                        commit={selectedCommit}
                        remote={remotes[repo ?? ""] ?? null}
                        platform={accounts[remotes[repo ?? ""]?.host ?? ""]?.kind ?? "github"}
                        autolinks={state.autolinks}
                        files={commitFiles}
                        selected={commitFile}
                        onSelect={setCommitFile}
                        onShowHistory={showFileHistory}>
                        <DiffView
                          file={commitFile}
                          diff={commitDiff}
                          selection={null}
                          error={null}
                          tokens={commitTokens}
                          repo={repo}
                          sha={commitSha}
                          oldPath={commitOldPath}
                          status={commitFileKind && <CommitStatusIcon kind={commitFileKind} />}
                          readOnly
                        />
                      </CommitDetails>
                    ) : (
                      <div className="text-muted-foreground flex flex-1 items-center justify-center">
                        {t("history.selectCommit")}
                      </div>
                    )
                  ) : status.changes.length === 0 ? (
                    // Desktop repository-view.tsx renderContentForChanges：没有本地改动时内容区是
                    // NoChanges 空白页，按仓库状态给出接下来能做的事
                    <NoChanges
                      repository={{
                        isHosted: !!remotes[repo ?? ""],
                        platform: accounts[remotes[repo ?? ""]?.host ?? ""]?.kind ?? "github"
                      }}
                      appMenu={appMenu}
                      repositoryState={{
                        branch: status.branch,
                        remote: status.remote,
                        aheadBehind: status.hasUpstream ? { ahead: status.ahead, behind: status.behind } : null,
                        tagsToPush,
                        isForcePush: forcePushBranchState === ForcePushBranchState.Recommended,
                        defaultBranch,
                        hasCurrentPullRequest,
                        isHosted: !!remotes[repo ?? ""],
                        stashEntry: desktopStashForBranch(stashList, status.branch)
                      }}
                      isExternalEditorAvailable
                      onOpenIntegrationPreferences={() => {
                        openPreferences("integrations")
                      }}
                    />
                  ) : selectedPaths.length > 1 ? (
                    <div className="text-muted-foreground flex flex-1 items-center justify-center">
                      {t("changes.selectedCount", { count: selectedPaths.length })}
                    </div>
                  ) : selectedChange?.submodule ? (
                    // 子模块不是文件，别拿它做文本 diff
                    <SubmoduleView
                      repo={repo}
                      file={selectedChange}
                      onOpen={path => {
                        patch({
                          repositories: [path, ...state.repositories.filter(r => r !== path)]
                        })
                        navigate(routes.repo(path))
                      }}
                    />
                  ) : (
                    <DiffView
                      file={selected}
                      diff={diff}
                      selection={cur?.selection ?? null}
                      tokens={tokens}
                      repo={repo}
                      status={selectedChange && <ChangeStatusIcon file={selectedChange} />}
                      lineEndings={lineEndings}
                      onDiscardLines={(source, lines) => void doDiscardLines(source, lines)}
                      onSelectionChange={next =>
                        selected &&
                        setFiles(prev =>
                          new Map(prev).set(selected, {
                            include: next.getSelectionType(),
                            selection: next,
                            diff: diff ?? undefined
                          })
                        )
                      }
                      error={null}
                    />
                  )}
                </div>
              </RepositorySplit>
            </>
          )}
        </div>
      </FloatingWorkspace>
    </TooltipProvider>
  )
}
