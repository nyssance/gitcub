/** 与 src-tauri/src/status.rs 的 serde 输出一一对应。
 *
 * 和 models/status.ts（原版移植）区分开：那边是 GitHub Desktop 的
 * 工作区文件模型（WorkingDirectoryFileChange 等），补丁生成要用。 */

/** 改动**暂存到哪一步**。 */
export type ChangeKind = "unstaged" | "staged" | "both" | "untracked"

/** 改动**类型**，决定图标和颜色。和 ChangeKind 正交：
 *  一个文件可以是「已暂存的删除」，也可以是「未暂存的删除」。 */
export type ChangeType = "added" | "modified" | "deleted" | "renamed" | "copied" | "conflicted"

/** 一个冲突文件的细节。 */
export interface Conflict {
  hasBase: boolean
  /** 我们这边（当前分支）还有这个文件吗。false = 我们删了它 */
  hasOurs: boolean
  /** 对面那条分支还有这个文件吗。false = 对面删了它 */
  hasTheirs: boolean
  /** 文件里还剩几处冲突标记 */
  markers: number
  /** 二进制文件：没有「冲突标记」可言，0 不代表已解决 */
  binary: boolean
}

/** 子模块的脏法。三件事分开：只有「指向的提交变了」能提交进父仓库。 */
export interface Submodule {
  commitChanged: boolean
  modified: boolean
  untracked: boolean
}

export interface FileChange {
  path: string
  kind: ChangeKind
  change: ChangeType
  /** 重命名前的路径。重命名在 index 里是两条记录，取消勾选时要连它一起退回 */
  oldPath: string | null
  /** 冲突细节。只有 change === "conflicted" 时才有值 */
  conflict: Conflict | null
  /** 是子模块时的细节。普通文件是 null */
  submodule: Submodule | null
}

/** 卡在哪个多步操作里。和 src-tauri/src/ops.rs 的 Operation 对应。 */
export type Operation = "merge" | "rebase" | "cherry-pick" | "revert"

export interface RepoStatus {
  branch: string | null
  changes: FileChange[]
  /** 远端名（通常是 origin）。为 null 时工具栏显示「发布分支」 */
  remote: string | null
  /** 当前分支是否已设上游。未设置时 ahead/behind 无意义 */
  hasUpstream: boolean
  ahead: number
  behind: number
  /** 有值就表示还没收尾：要么解决冲突后继续，要么中止 */
  operation: Operation | null
  /** 「对面」那条分支：合并时是被合进来的，变基时是变基到的 */
  theirs: string | null
}

/** 待办页用的摘要，与 status.rs 的 RepoSummary 对应。不含工作区改动，只有引用和索引能回答的事 */
export interface RepoSummary {
  branch: string | null
  remote: string | null
  hasUpstream: boolean
  ahead: number
  behind: number
  /** 未解决冲突的路径，按路径排序 */
  conflicts: string[]
}

/** 与 src-tauri/src/stage.rs 的 HunkView / HunkLine 对应。 */
export interface HunkLine {
  sign: "-" | "+"
  text: string
}

export interface HunkView {
  index: number
  header: string
  lines: HunkLine[]
}
