/** 与 src-tauri/src/history.rs 对应。 */

/** GitLens 的提交搜索查询（packages/git/src/models/search.ts 的 SearchQuery，去掉自然语言字段） */
export interface SearchQuery {
  query: string
  matchAll?: boolean
  matchCase?: boolean
  matchRegex?: boolean
  matchWholeWord?: boolean
}

/** Desktop `getCommits` 的原始提交记录（`--date=raw`、未折叠的 trailers、`%D` 装饰）。 */
export interface CommitDetails {
  sha: string
  shortSha: string
  summary: string
  body: string
  author: string
  committer: string
  parents: string
  trailers: string
  refs: string
}

export interface CommitInfo {
  sha: string
  shortSha: string
  summary: string
  body: string
  authorName: string
  authorEmail: string
  /** Unix 秒 */
  time: number
  /** 父提交个数。>1 就是合并提交 */
  parentCount: number
  parentSHAs: string[]
  tags: string[]
}

export type CommitFileKind = "added" | "modified" | "deleted" | "renamed" | "copied"

export interface CommitFile {
  path: string
  kind: CommitFileKind
  oldPath: string | null
  renameIncludesModifications: boolean
  submodule: boolean
  /** `--numstat` 的增删行数；二进制文件是 null（git 输出 `-`），Desktop 按 0 计入总数 */
  linesAdded: number | null
  linesDeleted: number | null
}

/** 提交图的一行：提交 + 它在第几条泳道 + 这一行之后各泳道的状态 */
export interface GraphRow {
  commit: CommitInfo
  lane: number
  lanes: (string | null)[]
  /** 指向这个提交的分支 / 标签名：HEAD 所在分支在前，然后是本地分支、远端分支、标签 */
  refs: string[]
  /** 这个提交所在泳道的色流：开泳道时分配，泳道左移、翻页都不变 */
  stream?: number
  /** 与 lanes 一一对应的色流 */
  streams?: number[]
  /** HEAD 指向这个提交时 HEAD 所在分支的短名；分离 HEAD 时是 "HEAD" */
  head?: string | null
  /** 与 refs 中的分支同序的完整引用：同短名的本地分支与远端跟踪分支靠它区分 */
  branches?: GraphBranch[]
  /** 贮藏行：stash@{n} 的 n。贮藏行的 parentSHAs 只有基提交 */
  stash?: number | null
  /** HEAD 能走到这个提交。提交图从全部分支、标签和贮藏遍历，改写历史只对这些行成立 */
  onHead?: boolean
}

/** 提交图上的分支装饰。remote 是远端跟踪分支所属的远端（按最长的已配置远端拆分），本地分支为 null */
export interface GraphBranch {
  reference: string
  remote: string | null
}

/** 一页提交图算完之后的泳道状态，下一页从这里接着算 */
export interface GraphCursor {
  lanes: string[]
  streams: number[]
  nextStream: number
}

/** 一页文件历史。多取的那一条决定 hasMore */
export interface FileHistoryPage {
  commits: CommitInfo[]
  hasMore: boolean
  /** 下一页的续走游标，不透明；没有时下一页从头走 */
  cursor: string | null
}

export interface GraphPage {
  rows: GraphRow[]
  cursor: GraphCursor
  /** 这一页已经是最后一页 */
  done: boolean
}

/** blame 的一行 */
export interface BlameLine {
  line: number
  sha: string
  shortSha: string
  author: string
  /** Unix 秒 */
  time: number
  summary: string
  content: string
}

/** 与 src-tauri/src/history.rs 的 Comparison 对应。 */
export interface Comparison {
  /** 我有、对方没有的 */
  ahead: CommitInfo[]
  /** 对方有、我没有的 */
  behind: CommitInfo[]
}

export interface CommitOneLine {
  sha: string
  summary: string
}
export interface Changeset {
  files: CommitFile[]
  linesAdded: number
  linesDeleted: number
  commitish: string
  parentCommitish: string
}
export interface MultiCommitProgress {
  kind: "multiCommitOperation"
  currentCommitSummary: string
  position: number
  totalCommitCount: number
  value: number
}
export interface RebaseSnapshot {
  commits: CommitOneLine[]
  progress: MultiCommitProgress
}
export interface CherryPickSnapshot extends RebaseSnapshot {
  remainingCommits: CommitOneLine[]
  targetBranchUndoSha: string
  cherryPickedCount: number
}
export interface OperationOutcome<T extends string> {
  result: T
  progress: MultiCommitProgress[]
  diagnostic: string
}
export type RebaseResult =
  "CompletedWithoutError" | "AlreadyUpToDate" | "ConflictsEncountered" | "OutstandingFilesNotStaged" | "Aborted"
export type CherryPickResult =
  "CompletedWithoutError" | "ConflictsEncountered" | "OutstandingFilesNotStaged" | "UnableToStart"
