import { Channel, invoke } from "@tauri-apps/api/core"

import type {
  Accounts,
  AppState,
  Branch,
  BranchDetails,
  CheckRetry,
  CheckRun,
  CommitOptions,
  DeviceStart,
  GitIdentity,
  ImageDiff,
  Issue,
  LfsState,
  MergePreview,
  PollStatus,
  PullRequest,
  Remote,
  RemoteRepo,
  RepoMeta,
  RepositoryTip,
  ResetMode,
  Resolution,
  StashEntry,
  SubmoduleInfo,
  Worktree
} from "@/models/app-state"
import type { BrowserAction, BrowserState } from "@/models/browser"
import type {
  BlameLine,
  Changeset,
  CherryPickResult,
  CherryPickSnapshot,
  CommitDetails,
  CommitFile,
  CommitInfo,
  CommitOneLine,
  Comparison,
  FileHistoryPage,
  GraphCursor,
  GraphPage,
  OperationOutcome,
  RebaseResult,
  RebaseSnapshot,
  SearchQuery
} from "@/models/history"
import type { FileChange, Operation, RepoStatus, RepoSummary } from "@/models/repo-status"

import { clone } from "./clone"
import type { IMentionableUser } from "./databases/github-user-database"
import { fetch, pull } from "./fetch"
import { executeGit } from "./git-execution"
import { prepareImageDiff } from "./image-data"
import { type TerminalChunk, TerminalOutputDecoder } from "./terminal-output-decoder"

/** 提交图一页多少条。同 Desktop 的 `CommitBatchSize`（app/src/lib/stores/git-store.ts） */
export const GRAPH_BATCH = 100
/** 文件历史一页多少条。和提交图同一个批量（Desktop 的 `CommitBatchSize`） */
export const FILE_HISTORY_BATCH = 100

/** 对 Tauri command 的薄封装。
 *
 * 刻意不缓存任何东西：状态的唯一来源是仓库本身。
 * GitHub Desktop 的性能问题有一半来自前端那个万行 app-store 缓存了所有状态，
 * 任何操作完成都要全量比对再大面积重渲染。 */
function operationOutput(onOutput?: (text: string) => void) {
  const channel = new Channel<TerminalChunk>()
  const decoder = new TerminalOutputDecoder()
  channel.onmessage = chunk => onOutput?.(decoder.push(chunk))
  return channel
}
// Native requests can arrive out of order. Finish stopping the previous watch
// before starting the next, including while restoring a repository on startup.
let changingWatch: Promise<void> = Promise.resolve()
function watchRepo(repo: string | null): Promise<void> {
  const next = changingWatch.catch(() => {}).then(() => invoke<void>("watch_repo", { repo }))
  changingWatch = next
  return next
}
export interface DesktopImport {
  accountHosts?: string[]
  repositories: string[]
  selectedRepository: string | null
  theme: string | null
  sidebarWidth: number | null
  externalEditor: string | null
  externalTerminal: string | null
  skipped: string[]
}
export const ipc = {
  hasTrackpad: () => invoke<boolean>("has_trackpad"),
  detectDesktopImport: () =>
    invoke<{ installed: boolean; hasData: boolean; handled: boolean }>("detect_desktop_import"),
  finishDesktopImport: (shouldImport: boolean) => invoke<AppState>("finish_desktop_import", { import: shouldImport }),
  readDesktopImport: () => invoke<DesktopImport>("read_desktop_import"),
  fetchRefspec: (repo: string, remote: string, refspec: string) =>
    invoke<void>("fetch_refspec", { repo, remote, refspec }),
  addWorktreeAt: (repo: string, path: string, createBranch?: string, commitish?: string) =>
    invoke<void>("add_worktree_at", { repo, path, createBranch, commitish }),
  temporaryFilePath: (name: string) => invoke<string>("temporary_file_path", { name }),
  readPartialFile: (path: string, start: number, end: number) =>
    invoke<number[]>("read_partial_file", { path, start, end }),
  executeGit,
  fileHash: (path: string, algorithm: "sha1" | "sha256" = "sha256") => invoke<string>("file_hash", { path, algorithm }),
  resolveWithin: (root: string, ...segments: string[]) => invoke<string | null>("resolve_within", { root, segments }),
  encodePathUrl: (...segments: string[]) => invoke<string>("encode_path_url", { segments }),
  isApplicationBundleMetadata: (metadata: string) => invoke<boolean>("is_application_bundle_metadata", { metadata }),
  formatCommitMessage: (
    repo: string,
    summary: string,
    description: string | null = null,
    trailers: { token: string; value: string }[] = []
  ) => invoke<string>("format_commit_message", { repo, summary, description, trailers }),
  writeDefaultReadme: (repo: string, name: string, description?: string) =>
    invoke<void>("write_default_readme", { repo, name, description }),
  mergeBaseFiles: (repo: string, from: string, to: string, latest = to) =>
    invoke<Changeset | null>("merge_base_files", { repo, from, to, latest }),
  partialBlob: (repo: string, revision: string, file: string, length: number) =>
    invoke<number[] | null>("partial_blob_contents", { repo, revision, file, length }),
  commitsInRange: (repo: string, range: string) => invoke<CommitOneLine[] | null>("commits_in_range", { repo, range }),
  hasMergesAfter: (repo: string, revision?: string) => invoke<boolean>("has_merges_after", { repo, revision }),
  rebaseSnapshot: (repo: string) => invoke<RebaseSnapshot | null>("rebase_snapshot", { repo }),
  rebaseWithProgress: (repo: string, base: string, target?: string) =>
    invoke<OperationOutcome<RebaseResult>>("rebase_with_progress", { repo, base, target }),
  continueRebaseWithResolutions: (repo: string, paths: string[], resolutions: [string, Resolution][] = []) =>
    invoke<OperationOutcome<RebaseResult>>("continue_rebase_with_resolutions", { repo, paths, resolutions }),
  cherryPickSnapshot: (repo: string) => invoke<CherryPickSnapshot | null>("cherry_pick_snapshot", { repo }),
  cherryPickWithProgress: (repo: string, commits: CommitOneLine[]) =>
    invoke<OperationOutcome<CherryPickResult>>("cherry_pick_with_progress", { repo, commits }),
  continueCherryPick: (repo: string, paths: string[], resolutions: [string, Resolution][] = []) =>
    invoke<OperationOutcome<CherryPickResult>>("continue_cherry_pick", { repo, paths, resolutions }),
  repositoryType: (path: string) =>
    invoke<
      | { kind: "regular"; topLevelWorkingDirectory: string; gitDir: string }
      | { kind: "unsafe"; path: string }
      | { kind: "bare" | "missing" }
    >("repository_type", { path }),
  addSafeDirectory: (path: string) => invoke<void>("add_safe_directory", { path }),
  repositoryRoot: (path: string) => invoke<string>("repository_root", { path }),
  loadState: () => invoke<AppState>("load_state"),
  repoRemote: (repo: string) => invoke<Remote | null>("repo_remote", { repo }),
  parseRemote: (url: string) => invoke<Remote | null>("parse_remote", { url }),
  /** refresh 为真时跳过缓存强制重拉（界面上的刷新按钮走这条） */
  accountInfo: (hosts: string[], refresh = false) => invoke<Accounts>("account_info", { hosts, refresh }),
  repoMeta: (host: string, owner: string, name: string, kind: "github" | "gitlab") =>
    invoke<RepoMeta | null>("repo_meta", { host, owner, name, kind }),
  setToken: (host: string, token: string) => invoke<void>("set_token", { host, token }),
  setAccountIgnored: (host: string, ignored: boolean) => invoke<void>("set_account_ignored", { host, ignored }),
  myRepos: (host: string, refresh = false) => invoke<RemoteRepo[]>("my_repos", { host, refresh }),
  myStars: (host: string, refresh = false) => invoke<RemoteRepo[]>("my_stars", { host, refresh }),
  syncTrendingWebview: (
    session: string,
    frame: { x: number; y: number; width: number; height: number; visible: boolean } | null,
    reload: boolean,
    onLoad?: Channel<string>
  ) => invoke<void>("sync_trending_webview", { session, frame, reload, onLoad }),
  controlTrendingWebview: (session: string, action: BrowserAction) =>
    invoke<BrowserState>("control_trending_webview", { session, action }),
  /** 各实例内置的应用 ID（github.com 有一个，用户不用配） */
  oauthDefaultClients: () => invoke<Record<string, string>>("oauth_default_clients"),
  oauthDeviceStart: (host: string, clientId: string, kind: "github" | "gitlab", attemptId: string) =>
    invoke<DeviceStart>("oauth_device_start", { host, clientId, kind, attemptId }),
  oauthDevicePoll: (host: string, clientId: string, deviceCode: string, attemptId: string) =>
    invoke<PollStatus>("oauth_device_poll", { host, clientId, deviceCode, attemptId }),
  oauthDeviceCancel: (host: string, attemptId: string) => invoke<void>("oauth_device_cancel", { host, attemptId }),
  gitIdentity: (repo?: string) => invoke<GitIdentity>("git_identity", { repo }),
  setGitIdentity: (name: string, email: string, repo?: string) =>
    invoke<void>("set_git_identity", { repo, name, email }),
  saveState: (state: AppState) => invoke<void>("save_state", { state }),
  branches: (repo: string) => invoke<Branch[]>("branches", { repo }),
  branchDetails: (repo: string, pattern?: string) => invoke<BranchDetails[]>("branch_details", { repo, pattern }),
  repositoryTip: (repo: string) => invoke<RepositoryTip>("repository_tip", { repo }),
  branchesPointedAt: (repo: string, revision: string) =>
    invoke<string[] | null>("branches_pointed_at", { repo, revision }),
  mergeBase: (repo: string, first: string, second: string) =>
    invoke<string | null>("merge_base", { repo, first, second }),
  checkout: (repo: string, branch: string) => invoke<void>("checkout", { repo, branch }),
  createBranch: (repo: string, name: string, startPoint?: string, noTrack = false) =>
    invoke<void>("create_branch", { repo, name, startPoint, noTrack }),
  deleteBranch: (repo: string, name: string) => invoke<void>("delete_branch", { repo, name }),
  /** 丢弃改动：文件先进废纸篓再复位，捞得回来。
   *  子模块走另一条路（复位到父仓库记录的提交），所以只传它是不是子模块。 */
  discardChanges: (repo: string, files: FileChange[]) =>
    invoke<void>("discard_changes", {
      repo,
      files: files.map(f => ({
        path: f.path,
        oldPath: f.oldPath,
        change: f.change,
        submodule: f.submodule !== null
      }))
    }),
  cloneRepo: clone,
  writeGitAttributes: (repo: string) => invoke<void>("write_git_attributes", { repo }),
  /** 某个仓库的开放 PR / MR */
  pullRequests: (host: string, owner: string, name: string, refresh = false) =>
    invoke<PullRequest[]>("pull_requests", { host, owner, name, refresh }),
  /** 跟我有关的 PR：等我评审的 / 我开的 */
  involvedPrs: (host: string, kind: "reviewRequested" | "authored", refresh = false) =>
    invoke<PullRequest[]>("involved_prs", { host, kind, refresh }),
  /** 某个提交上的检查项 */
  checkRuns: (host: string, owner: string, name: string, sha: string) =>
    invoke<CheckRun[]>("check_runs", { host, owner, name, sha }),
  checkRerunEligibility: (host: string, owner: string, name: string, checks: CheckRun[]) =>
    invoke<number[]>("check_rerun_eligibility", { host, owner, name, checks }),
  rerunCheck: (
    host: string,
    owner: string,
    name: string,
    target: CheckRetry,
    mode: "failed" | "all" | "job",
    jobId?: number | null
  ) => invoke<void>("rerun_check", { host, owner, name, target, mode, jobId }),
  rerunFailedJobs: (host: string, owner: string, name: string, target: CheckRetry) =>
    invoke<void>("rerun_failed_jobs", { host, owner, name, target }),
  /** Fork 到自己名下，返回克隆地址 */
  forkRepo: (host: string, owner: string, name: string) => invoke<string>("fork_repo", { host, owner, name }),
  /** 这个仓库 fork 自哪里（owner/name）；不是 fork 就是 null */
  upstreamOf: (host: string, owner: string, name: string) =>
    invoke<string | null>("upstream_of", { host, owner, name }),
  /** 同步上游：拉源仓库的分支并快进 */
  syncUpstream: (repo: string, upstreamUrl: string, branch: string) =>
    invoke<void>("sync_upstream", { repo, upstreamUrl, branch }),
  /** 新建 PR / MR，返回网页地址 */
  pullRequestTargets: (repo: string, remoteName: string) =>
    invoke<import("./pull-request-navigation").PullRequestTargets>("pull_request_targets", { repo, remoteName }),
  pullRequestRepository: (host: string, owner: string, name: string) =>
    invoke<Remote>("pull_request_repository", { host, owner, name }),
  pullRequestSource: (host: string, owner: string, name: string, number: number) =>
    invoke<import("./pull-request-checkout").PullRequestSource & { kind: "github" | "gitlab" }>("pull_request_source", {
      host,
      owner,
      name,
      number
    }),
  createPullRequest: (
    host: string,
    owner: string,
    name: string,
    title: string,
    body: string,
    head: string,
    base: string
  ) => invoke<string>("create_pull_request", { host, owner, name, title, body, head, base }),
  /** 在远端建一个空仓库，返回克隆地址 */
  createRemoteRepo: (host: string, name: string, private_: boolean) =>
    invoke<string>("create_remote_repo", { host, name, private: private_ }),
  /** 逐行追溯 */
  blame: (repo: string, file: string) => invoke<BlameLine[]>("blame", { repo, file }),
  /** 搜索提交：GitLens 查询语法（message: author: file: change: #sha …），错误即语法校验信息 */
  searchCommits: (repo: string, query: SearchQuery, limit = 100, skip = 0) =>
    invoke<CommitInfo[]>("search_commits", { repo, query, limit, skip }),
  /** 单个文件的提交历史（跟过改名，GitLens 文件历史的语义），最新的在前。第 skip 条起的 limit 条；
   *  `cursor` 是上一页返回的续走游标：后端接着上一页停下的地方走；对不上（换了文件、HEAD 动了、
   *  过期）就按前 skip+limit+1 条重走 `--follow`，结果相同，翻页不会像 `--skip` 那样错位 */
  fileHistory: (repo: string, file: string, skip = 0, limit = FILE_HISTORY_BATCH, cursor: string | null = null) =>
    invoke<FileHistoryPage>("file_history", { repo, file, skip, limit, cursor }),
  /** 带泳道的一页提交。`cursor` 是上一页末尾的泳道状态，翻页时传回去，泳道和颜色才接得上 */
  graph: (repo: string, limit = GRAPH_BATCH, skip = 0, cursor: GraphCursor | null = null) =>
    invoke<GraphPage>("graph", { repo, limit, skip, cursor }),
  log: (repo: string, limit = 100, skip = 0) => invoke<CommitInfo[]>("log", { repo, limit, skip }),
  /** Desktop git-store.ts loadLocalCommits 没有上游那一支：`log HEAD --not --remotes`，
   *  HEAD 可达、任一远端跟踪分支都不可达的提交。走 commit_details 的进程内 gix 快路径，
   *  按 Desktop 的 CommitBatchSize 翻页；这里只要 SHA */
  localCommits: async (repo: string, limit = GRAPH_BATCH, skip = 0) => {
    const details = await invoke<CommitDetails[]>("commit_details", {
      repo,
      revision: "HEAD",
      limit,
      skip,
      additional: ["--not", "--remotes"]
    })
    return details.map(commit => commit.sha)
  },
  commitFiles: (repo: string, sha: string) => invoke<CommitFile[]>("commit_files", { repo, sha }),
  /** `oldPath`：重命名或复制前的路径（Desktop getCommitDiff 会一并传给 git）。 */
  commitFileDiff: (repo: string, sha: string, file: string, oldPath: string | null, hideWhitespace = false) =>
    invoke<string>("commit_file_diff_raw", { repo, sha, file, oldPath, hideWhitespace }),
  repoStatus: (repo: string) => invoke<RepoStatus>("repo_status", { repo }),
  /** 待办页用的摘要：分支、远端、领先数、冲突路径。不遍历工作区，可以对很多仓库连着问 */
  repoSummary: (repo: string) => invoke<RepoSummary>("repo_summary", { repo }),
  /** 盯住这个仓库的文件变化，变了就发 `repo-changed`。null = 不盯 */
  watchRepo,
  /** 这些文件里哪些又大又没走 LFS —— 推上去会被 GitHub 拒 */
  oversizedFiles: (repo: string, paths: string[]) => invoke<string[]>("oversized_files", { repo, paths }),
  /** 仓库里的 PR 模板；没有就是 null */
  prTemplate: (repo: string) => invoke<string | null>("pr_template", { repo }),
  /** 这个仓库和 LFS 的关系：用没用、有没有 git-lfs、过滤器生效没 */
  lfsState: (repo: string) => invoke<LfsState>("lfs_state", { repo }),
  /** 给这个仓库装上 LFS 过滤器 */
  lfsInstall: (repo: string) => invoke<void>("lfs_install", { repo }),
  /** 写提交信息时 `#` 补全用的 issue 号 */
  issuesForCompletion: (host: string, owner: string, name: string) =>
    invoke<Issue[]>("issues_for_completion", { host, owner, name }),
  /** 提交信息 `@` 补全与共同作者候选（Desktop fetchMentionables；GitLab 是项目里能被 @ 的用户） */
  mentionables: (host: string, owner: string, name: string) =>
    invoke<IMentionableUser[]>("mentionables", { host, owner, name }),
  /** 两版图片本身。sha 给了是看某次提交，没给是看工作区 */
  imageDiff: (repo: string, file: string, sha?: string) =>
    invoke<ImageDiff>("image_diff", { repo, file, sha }).then(prepareImageDiff),
  /** 子模块的细节：地址、记录的提交 vs 实际的提交、里面有多少没提交的东西 */
  submoduleInfo: (repo: string, file: string) => invoke<SubmoduleInfo>("submodule_info", { repo, file }),
  commit: (repo: string, summary: string, description: string, options: CommitOptions) =>
    invoke<void>("commit", { repo, summary, description, options }),
  /** token 由后端从钥匙串取，前端不接触 */
  /** setUpstream：远端还没有这条分支时要带；forceWithLease：强推（不是 --force） */
  push: (repo: string, remote: string, refspec: string, setUpstream = false, forceWithLease = false) =>
    invoke<void>("push", { repo, remote, refspec, setUpstream, forceWithLease }),
  fetch: (repo: string, remote: string) => fetch({ path: repo }, { name: remote }),
  pull: (repo: string, remote: string) => pull({ path: repo }, { name: remote }),

  // ── 分支操作 ────────────────────────────────────────────────────
  /** 合之前先算一下会不会冲突 */
  mergePreview: (repo: string, ours: string, theirs: string) =>
    invoke<MergePreview>("merge_preview", { repo, ours, theirs }),
  mergeBranch: (repo: string, branch: string, squash = false) => invoke<void>("merge_branch", { repo, branch, squash }),
  continueOperation: (repo: string, operation: Operation) => invoke<void>("continue_operation", { repo, operation }),
  abortOperation: (repo: string, operation: Operation) => invoke<void>("abort_operation", { repo, operation }),
  rebaseBranch: (repo: string, base: string, onOutput?: (text: string) => void) =>
    invoke<void>("rebase_branch", { repo, base, output: operationOutput(onOutput) }),
  renameBranch: (repo: string, from: string, to: string) => invoke<void>("rename_branch", { repo, from, to }),
  /** 返回 [领先, 落后] */
  /** 两条分支差在哪些提交上 */
  compareCommits: (repo: string, ours: string, theirs: string, limit = 200) =>
    invoke<Comparison>("compare_commits", { repo, ours, theirs, limit }),
  compareBranches: (repo: string, ours: string, theirs: string) =>
    invoke<[number, number]>("compare_branches", { repo, ours, theirs }),

  // ── 贮藏 ────────────────────────────────────────────────────────
  stashes: (repo: string) => invoke<StashEntry[]>("stashes", { repo }),
  stashPush: (repo: string, branch: string) => invoke<void>("stash_push", { repo, branch }),
  stashPop: (repo: string, name: string) => invoke<void>("stash_pop", { repo, name }),
  stashDrop: (repo: string, name: string) => invoke<void>("stash_drop", { repo, name }),

  // ── 撤销与历史操作 ──────────────────────────────────────────────
  undoCommit: (repo: string) => invoke<void>("undo_commit", { repo }),
  amendCommit: (repo: string, summary: string, description: string) =>
    invoke<void>("amend_commit", { repo, summary, description }),
  resetTo: (repo: string, mode: ResetMode, target: string) => invoke<void>("reset_to", { repo, mode, target }),
  revertCommit: (repo: string, sha: string, isMerge = false) => invoke<void>("revert_commit", { repo, sha, isMerge }),
  /** 把若干提交压成一个（重写历史） */
  squashCommits: (repo: string, toSquash: string[], onto: string, lastRetained: string | null, message: string) =>
    invoke<void>("squash_commits", { repo, toSquash, onto, lastRetained, message }),
  /** 把若干提交挪到 before 之前，before 为 null = 挪到最后（重写历史） */
  reorderCommits: (repo: string, toMove: string[], before: string | null, lastRetained: string | null) =>
    invoke<void>("reorder_commits", { repo, toMove, before, lastRetained }),
  cherryPick: (repo: string, shas: string[], onOutput?: (text: string) => void) =>
    invoke<void>("cherry_pick", { repo, shas, output: operationOutput(onOutput) }),

  // ── 标签 ────────────────────────────────────────────────────────
  tags: (repo: string) => invoke<string[]>("tags", { repo }),
  createTag: (repo: string, name: string, sha: string) => invoke<void>("create_tag", { repo, name, sha }),
  deleteTag: (repo: string, name: string) => invoke<void>("delete_tag", { repo, name }),

  tagTargets: (repo: string) => invoke<Record<string, string>>("tag_targets", { repo }),
  tagsToPush: (repo: string, remote: string, branch: string) =>
    invoke<string[]>("tags_to_push", { repo, remote, branch }),
  pushWithTags: (repo: string, remote: string, branch: string, tags: string[], force = false, setUpstream = false) =>
    invoke<void>("push_with_tags", { repo, remote, branch, tags, options: { forceWithLease: force, setUpstream } }),

  // ── 交给系统上的其他工具 ────────────────────────────────────────
  revealInFileManager: (path: string) => invoke<void>("reveal_in_file_manager", { path }),
  openInTerminal: (path: string) => invoke<void>("open_in_terminal", { path }),
  availableIntegrations: () =>
    invoke<{ name: string; bundleId: string; kind: "editor" | "terminal"; path: string }[]>("available_integrations"),
  openInEditor: (path: string) => invoke<void>("open_in_editor", { path }),

  // ── 新建与发布 ──────────────────────────────────────────────────
  initRepo: (path: string, defaultBranch = "main") => invoke<void>("init_repo", { path, defaultBranch }),
  addRemote: (repo: string, name: string, url: string) => invoke<void>("add_remote", { repo, name, url }),
  /** 远端列表：[名字, URL] */
  remotes: (repo: string) => invoke<[string, string][]>("remotes", { repo }),
  remotePushUrl: (repo: string, name: string) => invoke<string>("remote_push_url", { repo, name }),
  setRemoteUrl: (repo: string, name: string, url: string) => invoke<void>("set_remote_url", { repo, name, url }),
  removeRemote: (repo: string, name: string) => invoke<void>("remove_remote", { repo, name }),
  readGitignore: (repo: string) => invoke<string>("read_gitignore", { repo }),
  /** Desktop appendIgnoreFile：路径按字面量加进 .gitignore（特殊字符转义） */
  appendIgnoreFiles: (repo: string, paths: string[]) => invoke<void>("append_ignore_files", { repo, paths }),
  /** Desktop appendIgnoreRule：`*.ext` 这样的规则 */
  appendIgnoreRules: (repo: string, patterns: string[]) => invoke<void>("append_ignore_rules", { repo, patterns }),
  writeGitignore: (repo: string, content: string) => invoke<void>("write_gitignore", { repo, content }),

  // ── 工作树 ──────────────────────────────────────────────────────
  repositoryDescription: (repo: string) => invoke<string>("repository_description", { repo }),
  recentBranches: (repo: string, limit = 10) => invoke<string[]>("recent_branches", { repo, limit }),
  branchCheckouts: (repo: string, after: string) => invoke<Record<string, string>>("branch_checkouts", { repo, after }),
  listSubmodules: (repo: string) =>
    invoke<{ sha: string; path: string; describe: string }[]>("list_submodules", { repo }),
  resetSubmodules: (repo: string, paths: string[]) => invoke<void>("reset_submodules", { repo, paths }),
  formatPatch: (repo: string, base: string, head: string) => invoke<string>("format_patch", { repo, base, head }),
  usingLfs: (repo: string) => invoke<boolean>("using_lfs", { repo }),
  trackedByLfs: (repo: string, file: string) => invoke<boolean>("tracked_by_lfs", { repo, file }),
  filesNotTrackedByLfs: (repo: string, paths: string[]) =>
    invoke<string[]>("files_not_tracked_by_lfs", { repo, paths }),
  fastForwardBranches: (repo: string) => invoke<void>("fast_forward_branches", { repo }),
  lastBranchStash: (repo: string, branch: string) => invoke<StashEntry | null>("last_branch_stash", { repo, branch }),
  dropStashSha: (repo: string, sha: string) => invoke<void>("drop_stash_sha", { repo, sha }),
  popStashSha: (repo: string, sha: string) => invoke<void>("pop_stash_sha", { repo, sha }),
  worktrees: (repo: string) => invoke<Worktree[]>("worktrees", { repo }),
  worktreesFromGitDir: (gitDir: string) => invoke<Worktree[]>("worktrees_from_git_dir", { gitDir }),
  mainWorktreePath: (repo: string, mainPath?: string, gitDir?: string) =>
    invoke<string | null>("main_worktree_path", { repo, mainPath, gitDir }),
  addWorktree: (repo: string, path: string, branch: string, create: boolean) =>
    invoke<void>("add_worktree", { repo, path, branch, create }),
  removeWorktree: (repo: string, path: string) => invoke<void>("remove_worktree", { repo, path }),
  moveWorktree: (repo: string, oldPath: string, newPath: string) =>
    invoke<void>("move_worktree", { repo, oldPath, newPath }),

  // ── 冲突 ────────────────────────────────────────────────────────
  resolveConflict: (repo: string, file: string, keep: Resolution) =>
    invoke<void>("resolve_conflict", { repo, file, keep })
}
