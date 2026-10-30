/** GitLens integration suites run under Mocha's TDD interface (suite/test/suiteSetup/suiteTeardown/setup/teardown).
 * The snapshots stay byte-for-byte; at load time this maps those globals onto node:test and leaves out the suite and
 * test blocks registered below, each with the reason it cannot run against GitCub production code. Imports used only
 * by excluded blocks (sinon stubs, GitLens error classes) are dropped so the bundle does not need them. The same
 * titles and reasons are listed in tests/gitlens/manifest.json. A title that no longer occurs in the snapshot fails
 * the load, so an upstream rename cannot silently re-include or hide a block. */
type Adaptation = { excluded: Record<string, string>; droppedImports?: string[] }

const sinon = "import * as sinon from 'sinon';\n"
const cache = "GitLens 缓存/事件钩子，GitCub 不缓存 git 结果"
// operations / graph suites
const reason = "GitLens 错误原因分类，GitCub 生产错误是 Git 原文、不分原因"
const checkedOut = "GitCub 推送、拉取、fetch 只作用于检出分支（Desktop 工具栏）"
const localUpstreamPush =
  "采用 Desktop 语义：跟踪本地分支（branch.<名>.remote = .）的分支推送时，Desktop performPush 用 `branch.upstreamRemoteName || remote.name`，" +
  "远端名取自 %(upstream:short)，本地上游没有远端前缀，于是推到当前远端并由 git/push.ts 加 --set-upstream 发布；GitLens 拒绝并报 noUpstream。" +
  "回归测试见 branch-workflows.test.ts「a branch tracking a local branch pushes to the current remote as Desktop does」"
const revision = `推送指定提交（revision 引用），${checkedOut}`
const fastForwardOnly = "--ff-only 选项：Desktop/GitCub 拉取按 pull.ff 配置，未设置时 --ff"

export const gitLensIntegrationAdaptations: Record<string, Adaptation> = {
  "gitlens/integration/tags.test.ts": {
    excluded: { "getTags reports annotated vs lightweight tags": "GitCub 标签列表（ops::all_tags）不区分附注/轻量标签" }
  },
  "gitlens/integration/remotes.test.ts": {
    excluded: {
      "adding a remote with fetch, then removing it, refreshes a count that excludes remote-tracking branches": `GitLens 提交计数（excluding remotes）与 addRemote --fetch 选项，${cache}`
    }
  },
  "gitlens/integration/worktrees.test.ts": {
    droppedImports: [sinon],
    excluded: {
      "pruneWorktrees removes the admin entry of a worktree whose directory was deleted out from under git":
        "Desktop/GitCub 无 worktree prune",
      "pruneWorktrees unregisters the cache entry for a worktree it removes": "Desktop/GitCub 无 worktree prune",
      "lockWorktree records a reason and unlockWorktree clears it": "Desktop/GitCub 无 worktree lock/unlock",
      "locking and unlocking a worktree keeps a sibling worktree's cached git results":
        "Desktop/GitCub 无 worktree lock/unlock",
      "a forced getWorktrees sees a worktree created outside the provider, and matches its new branch": `force 读取与 sinon 进程计数，${cache}`,
      "a forced getWorktrees of an unchanged repository re-reads only the worktree list": `force 读取与 sinon 进程计数，${cache}`,
      "a cancelled createWorktree rejects as CancellationError, not WorktreeCreateError":
        "GitLens AbortSignal 取消语义，GitCub 工作树操作无取消入口",
      "a cancelled deleteWorktree rejects as CancellationError, not WorktreeDeleteError":
        "GitLens AbortSignal 取消语义，GitCub 工作树操作无取消入口"
    }
  },
  "gitlens/integration/config.test.ts": {
    droppedImports: [sinon],
    excluded: {
      "ConfigSubProvider — gk branch sections": "GitLens gk 分支元数据（.git/gk/config），GitCub 无此存储",
      "ConfigSubProvider — held config lock": "GitLens gk 配置写入的锁重试",
      "ConfigSubProvider — concurrent gk config writes": "GitLens gk 配置写入合并",
      "each worktree reads its own config.worktree value, whichever read first":
        "getConfigRegex 无 GitCub 对应（应用只按键读取）",
      "a worktree read first does not leak its config.worktree value to the others":
        "getConfigRegex 无 GitCub 对应（应用只按键读取）",
      "getSigningConfig and getCurrentUser read the linked worktree's own values after the main checkout read first":
        "GitLens getSigningConfig/getCurrentUser 模型，GitCub 无对应入口",
      "a shared write clears every worktree's cached read, not just the one that wrote": `getConfigRegex，${cache}`,
      "a write from one worktree clears the others' cached read of the key it changed": `getConfigRegex，${cache}`,
      "getConfigRegexAll serves the shared value to every worktree, never a config.worktree value":
        "getConfigRegexAll 无 GitCub 对应"
    }
  },
  "gitlens/integration/config.upstreamKeys.test.ts": {
    excluded: {
      'setConfig on branch.<name>.remote fires onReset(repoPath, "branches")': cache,
      "setConfig on a non-upstream key (e.g. core.hooksPath) fires no reset": cache
    }
  },
  "gitlens/integration/clone.test.ts": {
    excluded: {
      "runOptions.env reaches the clone":
        "用例不给 folderName，要 GitLens 按 URL 自行定目录名；Desktop/GitCub 克隆目标路径由用户在对话框确定，生产 branch::clone_output 只接受完整路径（runOptions.env 本身已映射，见 'an unreachable remote rejects…'）",
      "without folderName, the existing default-name auto-numbering still happens":
        "Desktop/GitCub 由用户选择克隆目录，无自动编号"
    }
  },
  "gitlens/integration/provider.test.ts": {
    excluded: {
      "bare option creates a bare repository": "Desktop/GitCub 不新建裸仓库",
      "PatchGitSubProvider.createEmptyInitialCommit": "Desktop/GitCub 不创建空树初始提交",
      "CliGitProvider.notifyChanged": cache
    }
  },
  "gitlens/integration/refs.test.ts": {
    droppedImports: [sinon, "import { ReferenceUpdateError } from '@gitlens/git/errors.js';\n"],
    excluded: {
      "getReference resolves a branch name": "GitLens GitReference 模型，GitCub 无对应入口",
      "getSymbolicReferenceNameOrMissing reports only a ref git confirms is gone as missing":
        "GitLens 引用名/缺失判定，GitCub 无对应入口",
      "RefsSubProvider ref updates": "GitLens 引用写入 API（CAS、钩子、gk 元数据清理），GitCub 无对应入口",
      "RefsSubProvider.validateReference — force bypasses the cache": cache,
      "RefsSubProvider.getReference — force bypasses the branch cache": cache,
      "RefsSubProvider.getReflogEntries": "GitLens reflog 视图，GitCub 无对应入口"
    }
  },
  // ── operations / graph suites ──
  "gitlens/integration/operations.test.ts": {
    droppedImports: [sinon],
    excluded: {
      "returns { conflicted: true, conflicts } when merge has conflicts":
        "fastForward: false（--no-ff）：Desktop merge.ts 与 GitCub ops::merge 只有 squash 选项",
      'throws CommitError with reason "nothingToCommit" on clean working tree': `${reason}（nothingToCommit）`,
      "author option sets commit author": "Desktop/GitCub 提交无 --author 覆盖，只有 Co-authored-by 共同作者",
      "all option stages modified tracked files": "Desktop/GitCub 提交前按勾选写入 index，无 commit -a",
      "OperationsGitSubProvider signing":
        "GitLens 宿主签名钩子（onSigned/onSigningFailed）与签名覆盖（signing.enabled），GitCub 提交按用户 Git 配置签名",
      "a reference whose upstream is missing sets tracking and announces config": `断言 onChanged('config')，${cache}`,
      "a commit pushed onto the current branch lands on its upstream name on the remote": revision,
      "publishing a branch tracking a local branch creates it on the remote, leaving the local upstream's name alone":
        "publish 选项：GitCub 没有把已有本地上游的分支发布到指定远端的入口",
      "a branch tracking a local branch with a slash in its name": `按未检出分支 fetch / --ff-only 拉取，${checkedOut}`,
      "a branch tracking a local branch rejects with noUpstream and pushes nothing": localUpstreamPush,
      "a branch tracking a local branch with a slash in its name rejects with noUpstream": localUpstreamPush,
      "pushing the current branch with no upstream rejects with noUpstream":
        "采用 Desktop 语义：检出分支没有上游时推送即发布（Desktop performPush → push --set-upstream 到默认远端），不报 noUpstream",
      "a commit reference with no remote for the current branch rejects with noUpstream": revision,
      "a fast-forward-only pull of a branch reference advances it from that remote": `拉取未检出分支（--ff-only），${checkedOut}`,
      "a force push whose lease is stale rejects with rejectedWithLease": `${reason}（rejectedWithLease）`,
      "OperationsSubProvider — branch-creating checkout": "GitLens gk 分支元数据（.git/gk/config），GitCub 无此存储",
      "fast-forwards a clone that is a strict ancestor of its origin": fastForwardOnly,
      "refuses (throws PullError) a pull that cannot fast-forward": fastForwardOnly,
      'rejects with PullError "noUpstream" pulling the checked-out branch when it has no upstream': `${reason}（noUpstream）；检出分支无上游时 GitCub 工具栏显示发布而不是拉取`,
      "a branch not checked out anywhere": `拉取未检出分支，${checkedOut}`,
      "rejects (FetchError) fetching into a local branch that is checked out, since no -u is added":
        "采用 Desktop 语义：fetchRefspec 把退出码 128 视为成功（Desktop lib/git/fetch.ts successExitCodes [0, 128]），GitCub net::fetch_refspec 照搬",
      "OperationsGitSubProvider.fetch — remote HEAD symref":
        "GitLens setRemoteHeadIfMissing 与 Git 版本模拟（sinon 监视 provider.git.run、改写 git.supports），GitCub 无这些内部入口",
      "OperationsGitSubProvider.fetch — preserveFetchHead": "Desktop/GitCub fetch 无 --no-write-fetch-head 选项",
      "OperationsGitSubProvider — announcing a write that failed": `onChanged/onReset 通知与读取缓存，${cache}`,
      "OperationsGitSubProvider.fetch — announcing the refs it moved": `onChanged/onReset 通知，${cache}`,
      "OperationsGitSubProvider — failed writes still announce": `onChanged 通知，${cache}`,
      "OperationsGitSubProvider — naming the branch a HEAD-moving write moved": `onChanged/onReset 通知，${cache}`,
      "OperationsGitSubProvider — beforeIndexLockRetry rejection":
        "GitLens 宿主 index.lock 重试钩子（runOptions.beforeIndexLockRetry），GitCub 无此运行选项"
    }
  },
  "gitlens/integration/operations.upstreamRemote.test.ts": {
    excluded: {
      "an upstream a custom refspec fetches into refs/heads/ keeps its remote, so a push lands on that remote": `推送未检出分支，${checkedOut}`,
      "a hand-built reference to a branch tracking a remote still pushes to that remote": `推送未检出分支，${checkedOut}`,
      "the cold current-branch read keeps a local upstream apart from a remote of the upstream's first segment":
        localUpstreamPush,
      "a hand-built reference to a branch tracking a local branch is looked up, so a push does not go to a remote named for its first segment":
        localUpstreamPush
    }
  },
  "gitlens/integration/operations.indexLockHook.test.ts": { excluded: {} },
  "gitlens/integration/graph.slashRemote.test.ts": { excluded: {} },
  "gitlens/integration/graph.stashRows.test.ts": { excluded: {} }
}

// ── status / stash / pausedOperations / branches / commits ───────────────────────────────────────────────────
const untrackedAll = "Desktop/GitCub 状态固定 --untracked-files=all，没有 untracked 模式选项"
const untrackedPaths = "GitCub 状态读取不接受路径限定，应用总是读取整个工作区"
const desktopStash =
  "Desktop/GitCub 贮藏只有一种：连同未跟踪文件贮藏全部改动，消息固定为 !!GitHub_Desktop<分支>；saveStash 的路径、keepIndex、onlyStaged 无对应，" +
  "按自定义消息找贮藏的用例因此无法运行（不带路径与选项的 saveStash 已映射到 ops::stash_push，见 'pop removes the entry from the stash list (#3163)'）"
const errors = "import { GitError } from '../../../exec/git.js';\n"
const commitCount = "GitCub 无提交计数入口（rev-list --count）及其 excluding 引用排除"

Object.assign(gitLensIntegrationAdaptations, {
  "gitlens/integration/status.test.ts": {
    droppedImports: ["import { isCancellationError } from '@gitlens/utils/cancellation.js';\n", errors],
    excluded: {
      "untracked: 'no' returns no untracked files": untrackedAll,
      "untracked: 'normal' returns the directory as one entry": untrackedAll,
      "branch: false still returns the files, with no upstream state":
        "GitCub 状态读取总带分支与上游信息，没有 branch: false 选项",
      "StatusSubProvider — reads reject when git fails":
        "GitLens GitError 类型与 git stderr 文本契约、AbortSignal 取消，以及 getStatusForFile/getStatusForPath/getConflictingFiles/hasConflictingFiles 等 GitCub 无对应的入口；GitCub status::status 在仓库外与裸仓库里同样拒绝，但错误是 gix 的原文（「does not appear to be a git repository」「A working tree is required…」），不是 git 的 stderr，套件的 isNotARepositoryError 按 /not a git repository/ 匹配 stderr",
      "limits the read to the given folders and files": untrackedPaths,
      "dedupes overlapping paths": untrackedPaths,
      "matches a glob-like folder name literally": untrackedPaths,
      "an empty paths array answers empty": untrackedPaths,
      "batches paths that exceed the command-line limit": untrackedPaths
    }
  },
  "gitlens/integration/stash.test.ts": {
    excluded: {
      "StashSubProvider.createStash": "Desktop/GitCub 无 git stash create（不进贮藏列表的快照）",
      "StashSubProvider.applyStash (by SHA)":
        "按 SHA 应用 stash create 快照；Desktop/GitCub 无 stash create，也只有恢复（pop）列表中的贮藏，没有 apply",
      "StashSubProvider.saveStash": desktopStash,
      "StashSubProvider untracked files": `用自定义消息 saveStash 后读取贮藏文件并 apply（保留条目）；${desktopStash}，且无 apply`,
      "StashSubProvider.deleteStash": `按自定义消息 'first'/'second' 找贮藏；${desktopStash}`,
      "StashSubProvider.renameStash": "Desktop/GitCub 无重命名贮藏",
      "CommitsSubProvider.getLog with stashes after rebase":
        "GitLens 提交列表混排贮藏（getLog stashes: true）；Desktop/GitCub 历史列表不显示贮藏"
    }
  },
  "gitlens/integration/pausedOperations.test.ts": {
    droppedImports: ["import { PausedOperationContinueError } from '@gitlens/git/errors.js';\n"],
    excluded: {
      "a skip that lands on the next step conflicts still advances, despite rejecting":
        "GitLens skip 选项、PausedOperationContinueError 分类与 steps 模型；Desktop/GitCub 继续变基没有单独的跳过入口",
      "without messageEditor a headless continue of a conflicted rebase surfaces the editor failure":
        "GitCub 继续操作总以 GIT_EDITOR=: 无头执行，没有调用用户编辑器的路径",
      "with allowEmpty records the empty commit and concludes the cherry-pick":
        "Desktop continueCherryPick 在无改动时直接 commit --allow-empty，没有 allowEmpty 选项与 emptyCommit 错误分类",
      "with allowEmpty records the empty commit and concludes the revert":
        "GitLens allowEmpty 选项与 PausedOperationContinueError emptyCommit 分类，GitCub 无对应",
      "PausedOperationsGitSubProvider.getPausedOperationStatus":
        "GitLens GitPausedOperationStatus 模型（HEAD/incoming 提交信息、sequencer todo 解析）；GitCub 只识别进行中的操作类型",
      "is true during a stopped git am, where the status is undefined":
        "Desktop/GitCub 无 git am 流程；GitCub ops::in_progress 把 rebase-apply 一律视为变基进行中，与 GitLens「状态为 undefined」的模型不同"
    }
  },
  "gitlens/integration/branches.test.ts": {
    droppedImports: [sinon, "import { BranchError } from '@gitlens/git/errors.js';\n", errors],
    excluded: {
      "BranchesSubProvider.getBranchMergedStatus caching": `getBranchMergedStatus 与 sinon 进程计数，${cache}`,
      "BranchesSubProvider — default branch caching": `getDefaultBranchName 与 sinon 进程计数，${cache}`,
      "BranchesSubProvider.setRemoteHeadIfMissing — never prompts":
        "Desktop updateRemoteHEAD（GitCub remote_ops::update_head）按原版把退出码 1/128 当作成功静默忽略，GitLens 要求失败即拒绝；对照用例的 getDefaultBranchName 无 GitCub 对应",
      "BranchesSubProvider — partial batch delete":
        "GitLens 批量删除分支、gk 分支元数据与变更钩子；Desktop/GitCub 一次删除一个分支（branch -D），无 gk 元数据",
      "BranchesSubProvider — config-writing writes announce config": `GitLens repository.onChanged 变更通知，${cache}`,
      "BranchesSubProvider — branch identity bookkeeping (end to end)":
        "GitLens gk 分支元数据（gk-merge-base）与 BranchError 原因分类；Desktop/GitCub 删除本地分支用 branch -D，无此存储与分类",
      "BranchesSubProvider.getBranch — force bypasses the cache": cache,
      "BranchesSubProvider.getBaseBranchName — reflog fallback":
        "GitLens 基分支推断（getBaseBranchName 与 gk 元数据回写），Desktop/GitCub 无"
    }
  },
  "gitlens/integration/commits.test.ts": {
    droppedImports: [sinon],
    excluded: {
      "getCommitCount returns correct count": commitCount,
      "isAncestorOf works correctly": "GitCub 无祖先判定入口（merge-base --is-ancestor）",
      "a cancelled caller must not reject a concurrent caller sharing the in-flight spawn":
        "GitLens AbortSignal 取消与进程共享，GitCub 历史读取无取消入口",
      'a failed rev-list is not cached as a real "unknown" count': `getCommitCount 与 sinon 进程计数，${cache}`,
      "CommitsSubProvider.filterUnpublishedShas": "GitLens 提交图 WIP 未推送标记的批量判定，Desktop/GitCub 无",
      "CommitsSubProvider.getCommitCount — excluding": commitCount,
      "CommitsSubProvider.getLogShas — excluding": `GitLens getLogShas，${commitCount}`
    }
  }
} satisfies Record<string, Adaptation>)

export function withGitLensIntegrationGlobals(file: string, source: string): string {
  const adaptation = gitLensIntegrationAdaptations[file]
  if (!adaptation) return source
  for (const line of adaptation.droppedImports ?? []) {
    if (!source.includes(line)) throw new Error(`GitLens integration import changed: ${file}: ${line.trim()}`)
    source = source.replace(line, "")
  }
  for (const title of Object.keys(adaptation.excluded)) {
    const quoted = ["'", '"'].map(quote => `${quote}${title}${quote}`)
    if (!quoted.some(needle => source.includes(needle)))
      throw new Error(`GitLens integration block changed: ${file}: ${title}`)
  }
  return `import { after as suiteTeardown, afterEach as teardown, before as suiteSetup, beforeEach as setup, describe as __describe, it as __it } from "node:test";
const __excluded = new Set(${JSON.stringify(Object.keys(adaptation.excluded))});
const suite = (title, body) => (__excluded.has(title) ? undefined : __describe(title, body));
const test = (title, body) => (__excluded.has(title) ? undefined : __it(title, body));
test.skip = (title, body) => (__excluded.has(title) ? undefined : __it.skip(title, body));
${source}`
}
