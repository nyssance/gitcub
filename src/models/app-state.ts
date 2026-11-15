/** 与 src-tauri/src/store.rs 对应。 */
export interface AppState {
  /** 最近打开过的仓库，最新的排最前 */
  repositories: string[]
  selectedRepository: string | null
  desktopImportHandled?: boolean
  canvasTrackpadGestures?: boolean
  sidebarWidth: number
  selectedTab: string
  /** light | dark | system */
  theme: string
  /** 界面语言；空字符串表示跟随系统 */
  language: string
  externalEditor?: string
  externalTerminal?: string
  /** 仓库归属的手动修正，优先于按 origin owner 的自动判定 */
  repoOwnership: Record<string, Ownership>
  /** 手动加过的实例主机名（自建 GitLab 等）；公有实例和仓库里出现过的 host 不用记 */
  accountHosts: string[]
  /** 各实例的 OAuth client_id。设备码流程不需要 client secret，所以它不是密钥 */
  oauthClients: Record<string, string>
  oauthProviders?: Record<string, "github" | "gitlab">
  /** 提交信息里的 issue 引用规则（GitLens autolinks），全局生效 */
  autolinks?: AutolinkRule[]
  /** 欢迎流程走完或跳过了。存在 Rust 侧，不用 localStorage（macOS 下 tauri:// 的 localStorage 不落盘） */
  welcomed?: boolean
}

export type Ownership = "mine" | "third"

/** 一条自动链接规则：`prefix` 后跟编号，`url` 里的 `<num>` 换成编号。与 src-tauri/src/store.rs 的 AutolinkRule 对应。 */
export interface AutolinkRule {
  prefix: string
  url: string
  /** 编号允许字母数字（`\w+`），否则只认数字 */
  alphanumeric: boolean
  ignoreCase: boolean
  /** 链接的悬停标题，`<num>` 同样会替换 */
  title?: string
}

/** origin 远端拆出来的 host / owner / 名字 */
export interface Remote {
  host: string
  owner: string
  name: string
}

/** 凭据是从哪儿找到的 */
export type CredentialSource = "settings" | "gitCredential" | "desktop" | "cli"

/** 一个 host 上的账号。owners = 登录名 + 你所属的组织 / 群组 */
export interface Account {
  kind: "github" | "gitlab" | null
  login: string | null
  owners: string[]
  source: CredentialSource | null
  /** 用户显式登出过这个实例 */
  ignored: boolean
  /** 最近一次验证失败的原因；失败时其余字段是最后一次成功的结果 */
  error?: string | null
  /** 服务器以 401 拒绝了凭据（令牌过期或被吊销），需要重新登录 */
  unauthorized?: boolean
  /** 显示名与头像，来自同一次 `/user` 响应；设置里的账号行照 Desktop accounts.tsx 显示 */
  name?: string | null
  avatarUrl?: string | null
}

/** host -> 账号 */
export type Accounts = Record<string, Account>

/** Pull Request / Merge Request（两家统一成一套字段） */
export interface PullRequest {
  number: number
  createdAt?: string
  /** 源分支最新提交；查检查项要用 */
  headSha: string
  title: string
  author: string
  /** 源分支 */
  head: string
  /** 目标分支 */
  base: string
  draft: boolean
  url: string
  /** CI：success / failure / pending；取不到就是 null */
  checks: string | null
}

/** 工作树。主仓库自己也是一个 */
export interface Worktree {
  path: string
  branch: string | null
  main: boolean
  sha: string | null
  kind: "branch" | "bare" | "detached"
  locked: boolean | string
  prunable: boolean | string
}

export type CheckRetry = { kind: "githubWorkflow" | "githubCheckSuite" | "gitlabJob"; id: number }

/** 一个提交上的检查项 */
export interface CheckRun {
  checkSuiteId?: number | null
  id?: number
  description?: string
  appName?: string
  workflow?: import("../lib/api").IAPIWorkflowRun | null
  rerunnable?: boolean

  jobId?: number | null
  steps?: import("../lib/api").IAPIWorkflowJobStep[]
  retry: CheckRetry | null
  name: string
  /** queued / in_progress / completed */
  status: string
  /** success / failure / cancelled / skipped … */
  conclusion: string | null
  url: string
}

/** 贮藏条目 */
export interface StashEntry {
  /** 形如 stash@{0} */
  name: string
  sha: string
  message: string
  /** 是不是本客户端建的 */
  ours: boolean
}

export type ResetMode = "hard" | "mixed" | "soft"
export type Resolution = "ours" | "theirs"

/** 远端仓库：你自己的仓库列表和 star 列表都用它 */
export interface RemoteRepo {
  host: string
  owner: string
  name: string
  description: string | null
  language: string
  externalEditor?: string
  externalTerminal?: string | null
  stars: number
  private: boolean
  fork: boolean
  /** 克隆地址（HTTPS） */
  url: string
}

/** 设备码登录：给用户看的短码和验证地址 */
export interface DeviceStart {
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  deviceCode: string
  interval: number
  expiresIn: number
}

export type PollStatus = "pending" | "slowDown" | "done" | "denied" | "expired"

/** 提交选项。三项与原版齿轮菜单一一对应 */
export interface CommitOptions {
  skipHooks: boolean
  signOff: boolean
  allowEmpty: boolean
  /** 共同作者，每项形如 `名字 <邮箱>`，写成 Co-authored-by trailer */
  coAuthors: string[]
}

/** 仓库元信息，用来选图标 */
export interface RepoMeta {
  private: boolean
  fork: boolean
}

/** 只回报配没配，token 本身不会送到前端 */
export interface TokenStatus {
  github: boolean
  gitlab: boolean
}

export interface GitIdentity {
  name: string
  email: string
}

export interface Branch {
  name: string
  isCurrent: boolean
}

/** 与 src-tauri/src/system.rs 的 SubmoduleInfo 对应。 */
export interface SubmoduleInfo {
  fullPath: string
  /** .gitmodules 里写的地址 */
  url: string | null
  /** 父仓库记录的提交 */
  recorded: string | null
  /** 子模块实际检出的提交 */
  actual: string | null
  /** 子模块内部有多少条没提交的改动 */
  dirty: number
}

/** 与 src-tauri/src/ops.rs 的 MergePreview 对应。 */
export interface MergePreview {
  /** 会冲突的文件数，0 = 干净 */
  conflicts: number
  /** 两条线没有共同祖先，根本没法合 */
  unrelated: boolean
}

/** 与 src-tauri/src/image.rs 对应。图片 diff 的一侧。 */
export interface ImageSide {
  /** base64 的文件内容 */
  data: string
  mediaType: string
  bytes: number
}

export interface ImageDiff {
  /** 改动前那一版；新增的文件没有 */
  previous: ImageSide | null
  /** 改动后那一版；删掉的文件没有 */
  current: ImageSide | null
}

/** 写提交信息时 `#` 补全用的 issue。和 src-tauri/src/account.rs 的 Issue 对应。
 *  只有号码和标题——这里不是在做 issue 列表，那条早砍了。 */
export interface Issue {
  number: number
  title: string
}

/** 与 src-tauri/src/lfs.rs 的 LfsState 对应。 */
export interface LfsState {
  /** 这个仓库有 LFS 规则 */
  used: boolean
  /** 这台机器上有 git-lfs */
  available: boolean
  /** LFS 过滤器对这个仓库生效了 */
  installed: boolean
}

/** Canonical refs and upstream metadata from the production branch reader. */
export interface BranchDetails {
  name: string
  nameWithoutRemote: string
  upstream: string | null
  upstreamRef: string | null
  upstreamRemoteName: string | null
  upstreamWithoutRemote: string | null
  remoteName: string | null
  sha: string
  reference: string
  remote: boolean
}
export type RepositoryTip =
  { kind: "Unborn"; ref: string } | { kind: "Detached"; currentSha: string } | { kind: "Valid"; branch: BranchDetails }
