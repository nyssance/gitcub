// GitLens integration suites (packages/git-cli/src/providers/__tests__/integration) build their repositories with the
// original helpers.ts snapshot and then read them through `CliGitProvider`. The runner redirects helpers.ts's
// `../../../cliGitProvider.js`, `../../../exec/locator.js`, `../../../service.js`, `./shadowCheck.js` and
// `@gitlens/utils/logger.js` here (gitlens-modules.ts). This provider only translates GitLens's argument and return
// shapes onto GitCub production Rust behind the JSON bridge; it never runs git itself or computes an answer.
//
// Each sub-provider lists the methods a ported suite needs. Anything else throws "not mapped" on access, so a
// newly ported suite fails loudly until its method is mapped instead of reading a silent stand-in. To extend: add
// the method to the matching sub-provider below (or a new sub-provider in `subProviders`), calling a bridge
// operation that runs the production function.
import { join } from "node:path"

import { CommitError, FetchError, MergeError, PushError } from "@gitlens/git/errors.js"
import { normalizePath } from "@gitlens/utils/path.js"

import { BranchWorkflowError, pushWithRecovery } from "../../src/lib/branch-workflows"
import { GRAPH_BATCH, ipc } from "../../src/lib/ipc"
import { push } from "../../src/lib/push"
import type { BranchDetails } from "../../src/models/app-state"
import type { GraphCursor, GraphRow } from "../../src/models/history"
import { call } from "./bridge"

type NativeWorktree = {
  path: string
  branch: string | null
  main: boolean
  sha: string | null
  kind: "bare" | "branch" | "detached"
  locked: boolean | string
  prunable: boolean | string
}
type NativeRepositoryType =
  | { kind: "bare" }
  | { kind: "missing" }
  | { kind: "unsafe"; path: string }
  | { kind: "regular"; topLevelWorkingDirectory: string; gitDir: string }
type RunOptions = { env?: Record<string, string>; timeout?: number; cancellation?: AbortSignal }

export class NotMappedError extends Error {
  constructor(member: string, detail?: string) {
    super(`GitLens provider member not mapped to GitCub production code: ${member}${detail ? ` (${detail})` : ""}`)
    this.name = "NotMappedError"
  }
}

/** Rejects options the mapped production function has no counterpart for, instead of dropping them. */
function unsupported(member: string, options: object | undefined, allowed: readonly string[] = []) {
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined && !allowed.includes(key)) throw new NotMappedError(member, `option ${key}`)
  }
}

function guarded<T extends object>(name: string, target: T): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === "symbol" || key === "then" || key in object) return Reflect.get(object, key, receiver)
      throw new NotMappedError(`${name}.${key}`)
    }
  })
}

function repositoryType(path: string): NativeRepositoryType {
  return call("repository/type", { repo: path })
}

// ops::worktrees（应用工作树列表同一函数）→ GitWorktree 的数据字段。
function worktrees(repoPath: string) {
  return (call("worktree/list", { repo: repoPath }) as NativeWorktree[]).map(worktree => ({
    repoPath,
    path: worktree.path,
    isDefault: worktree.main,
    type: worktree.kind,
    sha: worktree.sha ?? undefined,
    branchName: worktree.branch ?? undefined,
    locked: worktree.locked,
    prunable: worktree.prunable
  }))
}

// ops::all_tags（Desktop getAllTags，附注标签解到提交）→ GitTag 的 name/sha。
function tags(repoPath: string) {
  return Object.entries(call("tags/list", { repo: repoPath }) as Record<string, string>).map(([name, sha]) => ({
    repoPath,
    name,
    sha
  }))
}

const subProviders = {
  config: () => ({
    // git_config::get（应用 get_config 同一函数），不加 --local / --type。
    async getConfig(repoPath: string | undefined, key: string, options?: object): Promise<string | undefined> {
      unsupported("config.getConfig", options)
      if (repoPath == null) throw new NotMappedError("config.getConfig", "global read")
      return (call("config/get", { repo: repoPath, key }) as string | null) ?? undefined
    },
    // git_config::set（--replace-all）；GitCub 没有取消设置的入口。
    async setConfig(repoPath: string | undefined, key: string, value: string | undefined, options?: object) {
      unsupported("config.setConfig", options)
      if (repoPath == null) throw new NotMappedError("config.setConfig", "global write")
      if (value === undefined) throw new NotMappedError("config.setConfig", "unset")
      call("config/set", { repo: repoPath, key, value })
    },
    // repository::repository_type（打开仓库时的识别）→ GitLens 富对象或空数组。repository_type 不报告 common
    // gitDir 与 superproject，这两个字段因而缺省。
    async getRepositoryInfo(cwd: string) {
      const type = repositoryType(cwd)
      if (type.kind === "missing") return []
      if (type.kind !== "regular") throw new NotMappedError("config.getRepositoryInfo", type.kind)
      return { repoPath: normalizePath(type.topLevelWorkingDirectory), gitDir: normalizePath(type.gitDir) }
    },
    async getGitDir(repoPath: string) {
      const type = repositoryType(repoPath)
      if (type.kind !== "regular") return undefined
      return { path: normalizePath(type.gitDir) }
    }
  }),
  // GitLens 按 checkout 缓存 git 结果，并靠 registerRepoPath 得知链接工作树的公共路径。GitCub 不做这种缓存：
  // 登记无事可做；公共路径由生产 ops::worktrees 的主工作树给出。
  cache: () => ({
    registerRepoPath(_uri: unknown, _gitDir: unknown) {},
    getCommonPath(repoPath: string): string | undefined {
      return worktrees(repoPath).find(worktree => worktree.isDefault)?.path
    }
  }),
  refs: () => ({
    // history::resolve_revision（rev-parse --verify --end-of-options）是否成功。
    async isValidReference(repoPath: string, ref: string, pathOrUri?: unknown) {
      if (pathOrUri !== undefined) throw new NotMappedError("refs.isValidReference", "pathOrUri")
      try {
        call("revision/resolve", { repo: repoPath, revision: ref })
        return true
      } catch {
        return false
      }
    },
    // ops::merge_base（分支比较同一函数）。
    async getMergeBase(repoPath: string, ref1: string, ref2: string, options?: object) {
      unsupported("refs.getMergeBase", options)
      return (call("merge/base", { repo: repoPath, first: ref1, second: ref2 }) as string | null) ?? undefined
    },
    // branch::list 与 ops::all_tags 是否有任一结果。
    async hasBranchOrTag(repoPath: string | undefined, options?: object) {
      unsupported("refs.hasBranchOrTag", options)
      if (repoPath == null) throw new NotMappedError("refs.hasBranchOrTag", "no repository")
      return call("branch/list", { repo: repoPath }).length > 0 || tags(repoPath).length > 0
    }
  }),
  remotes: () => ({
    // remote_ops::list（应用远端列表同一函数）→ GitRemote 的 name 与 fetch URL。
    async getRemotes(repoPath: string | undefined, options?: object) {
      unsupported("remotes.getRemotes", options)
      if (repoPath == null) throw new NotMappedError("remotes.getRemotes", "no repository")
      return (call("remote/list", { repo: repoPath }) as [string, string][]).map(([name, url]) => ({
        repoPath,
        name,
        urls: [{ type: "fetch", url }]
      }))
    }
  }),
  tags: () => ({
    async getTags(repoPath: string, options?: { filter?: (tag: { name: string; sha: string }) => boolean }) {
      unsupported("tags.getTags", options, ["filter"])
      const values = tags(repoPath)
      return { values: options?.filter ? values.filter(options.filter) : values }
    },
    async getTag(repoPath: string, name: string) {
      return tags(repoPath).find(tag => tag.name === name)
    }
  }),
  worktrees: () => ({
    async getWorktrees(repoPath: string, options?: object) {
      unsupported("worktrees.getWorktrees", options)
      return worktrees(repoPath)
    },
    // ops::remove_worktree（应用删除工作树同一函数）。timeout 只是 GitLens 的子进程超时，桥本身有固定上限。
    async deleteWorktree(repoPath: string, path: string, options?: object, runOptions?: RunOptions) {
      unsupported("worktrees.deleteWorktree", options)
      unsupported("worktrees.deleteWorktree", runOptions, ["timeout"])
      call("worktree/remove", { repo: repoPath, path })
    }
  })
}

// ── GitLens operations / graph suites ──────────────────────────────────────────────────────────────────────────
// Writes and the graph go through the app's TypeScript layer (src/lib/ipc.ts, push.ts, branch-workflows.ts) the way
// app.tsx composes it; tests/conformance/tauri.ts routes each Tauri command to the bridge operation that runs the same
// Rust function. A production rejection becomes the GitLens error class of the call; a GitLens reason is set only
// where production names one itself (BranchWorkflowError codes), never parsed from git output here.
type GitLensUpstream = { name: string; remote?: string; remoteBranch?: string; local?: boolean }
type GitLensReference =
  | { refType: "branch"; name: string; remote: boolean; upstream?: unknown }
  | { refType: "revision" | "stash" | "tag"; ref: string }

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

// branch::list（%(upstream)、%(upstream:remotename)、%(upstream:remoteref)）→ GitTrackingUpstream。远端为 "." 即
// 跟踪本地分支，GitLens 只标 local、不给 remote/remoteBranch 键。
function upstreamOf(details: BranchDetails): GitLensUpstream | undefined {
  if (details.upstream == null) return undefined
  if (details.upstreamRemoteName === ".") return { name: details.upstream, local: true }
  return {
    name: details.upstream,
    remote: details.upstreamRemoteName ?? undefined,
    remoteBranch: details.upstreamWithoutRemote ?? undefined
  }
}

// BranchDetails → GitBranch 的数据字段。remoteName / trackingWithoutRemote 取生产推送所用的同两项
// （branch-workflows.ts 的 upstreamRemoteName / upstreamWithoutRemote），而不是 GitLens 按名字拆分的回退。
function branchOf(repoPath: string, details: BranchDetails) {
  const upstream = upstreamOf(details)
  return {
    repoPath,
    refType: "branch" as const,
    ref: details.name,
    name: details.name,
    remote: details.remote,
    sha: details.sha,
    upstream,
    remoteName: details.remote
      ? (details.remoteName ?? undefined)
      : upstream?.local
        ? undefined
        : (details.upstreamRemoteName ?? undefined),
    trackingWithoutRemote: upstream?.local ? undefined : (details.upstreamWithoutRemote ?? undefined)
  }
}

/** GitCub 的推送、拉取只作用于检出的分支（Desktop 工具栏）；别的引用没有生产入口。 */
async function requireCheckedOut(member: string, repoPath: string, reference: GitLensReference) {
  if (reference.refType !== "branch" || reference.remote)
    throw new NotMappedError(member, `${reference.refType} reference`)
  const status = await ipc.repoStatus(repoPath)
  if (reference.name !== status.branch) throw new NotMappedError(member, "branch not checked out")
  return status
}

const operationSubProviders = {
  ops: () => ({
    // ops::merge（Tauri merge_branch，应用合并同一函数）。停在冲突上时 app.tsx 由随后刷新的状态显示冲突文件。
    async merge(repoPath: string, ref: string, options?: object) {
      unsupported("ops.merge", options)
      try {
        await ipc.mergeBranch(repoPath, ref)
        return { conflicted: false }
      } catch (error) {
        const status = await ipc.repoStatus(repoPath)
        const conflicts = status.changes.filter(change => change.change === "conflicted")
        if (status.operation === "merge" && conflicts.length > 0)
          return { conflicted: true, conflicts: conflicts.map(change => ({ path: change.path })) }
        throw new MergeError({ ref }, toError(error))
      }
    },
    // net::commit（Tauri commit）与 ops::amend（Tauri amend_commit）。GitLens 的整条信息即摘要，正文为空。
    async commit(
      repoPath: string,
      message: string,
      options?: { allowEmpty?: boolean; amend?: boolean },
      runOptions?: object
    ) {
      unsupported("ops.commit", options, ["allowEmpty", "amend"])
      unsupported("ops.commit", runOptions)
      if (message.includes("\n")) throw new NotMappedError("ops.commit", "multi-line message")
      if (options?.amend && options.allowEmpty) throw new NotMappedError("ops.commit", "amend with allowEmpty")
      try {
        if (options?.amend) await ipc.amendCommit(repoPath, message, "")
        else
          await ipc.commit(repoPath, message, "", {
            skipHooks: false,
            signOff: false,
            allowEmpty: options?.allowEmpty ?? false,
            coAuthors: []
          })
      } catch (error) {
        throw new CommitError({}, toError(error))
      }
    },
    // 工具栏推送：pushWithRecovery 读当前分支自己的上游（不用调用方给的 upstream），经 push.ts 走 net::push_with_tags。
    // force 即应用确认后的 --force-with-lease；被拒时的「先拉取」提示按用户拒绝处理。
    async push(repoPath: string, options?: { reference?: GitLensReference; force?: boolean }) {
      unsupported("ops.push", options, ["reference", "force"])
      if (options?.reference) await requireCheckedOut("ops.push", repoPath, options.reference)
      try {
        await pushWithRecovery(
          repoPath,
          options?.force ?? false,
          {
            ...ipc,
            push: (path, remote, branch, target, forceWithLease) =>
              push({ path }, { name: remote }, branch, target, null, { forceWithLease })
          },
          async () => false
        )
      } catch (error) {
        const reason = error instanceof BranchWorkflowError && error.code === "noUpstream" ? "noUpstream" : undefined
        throw new PushError({ reason }, toError(error))
      }
    },
    // net::fetch_refspec（Tauri fetch_refspec，单条 refspec）；检出分支的 fetch 即工具栏 Fetch：
    // app.tsx 的 fetchCurrent（有当前远端才 ipc.fetch，Desktop 对空远端列表不做事）；指定远端时 ipc.fetch(repo, remote)。
    async fetch(repoPath: string, options?: { remote?: string; refspecs?: string[]; branch?: GitLensReference }) {
      unsupported("ops.fetch", options, ["remote", "refspecs", "branch"])
      let run: () => Promise<unknown>
      if (options?.refspecs) {
        const [refspec, ...rest] = options.refspecs
        if (!options.remote || options.branch || refspec == null || rest.length > 0)
          throw new NotMappedError("ops.fetch", "refspecs other than one refspec of a named remote")
        const remote = options.remote
        run = () => ipc.fetchRefspec(repoPath, remote, refspec)
      } else if (options?.branch) {
        if (options.remote) throw new NotMappedError("ops.fetch", "branch with remote")
        const status = await requireCheckedOut("ops.fetch", repoPath, options.branch)
        run = async () => {
          if (status.remote) await ipc.fetch(repoPath, status.remote)
        }
      } else if (options?.remote) {
        const remote = options.remote
        run = () => ipc.fetch(repoPath, remote)
      } else throw new NotMappedError("ops.fetch", "fetch without a remote or branch")
      try {
        await run()
      } catch (error) {
        throw new FetchError({ remote: options?.remote }, toError(error))
      }
    }
  }),
  branches: () => ({
    // branch::list（Tauri branch_details，应用分支详情同一函数）。
    async getBranch(repoPath: string, name?: string) {
      if (name == null) throw new NotMappedError("branches.getBranch", "current branch")
      const details = (await ipc.branchDetails(repoPath, `refs/heads/${name}`)).find(
        branch => branch.reference === `refs/heads/${name}`
      )
      return details && branchOf(repoPath, details)
    },
    // current 取 branch::tip（Tauri repository_tip）的当前分支名，只对本地分支成立。
    async getBranches(repoPath: string, options?: { filter?: (branch: { name: string }) => boolean }) {
      unsupported("branches.getBranches", options, ["filter"])
      const tip = await ipc.repositoryTip(repoPath)
      const current = tip.kind === "Valid" ? tip.branch.name : undefined
      const values = (await ipc.branchDetails(repoPath)).map(details => ({
        ...branchOf(repoPath, details),
        current: !details.remote && details.name === current
      }))
      return { values: options?.filter ? values.filter(options.filter) : values }
    },
    // branch::tip（Tauri repository_tip）→ GitBranchReference。
    async getCurrentBranchReference(repoPath: string) {
      const tip = await ipc.repositoryTip(repoPath)
      if (tip.kind !== "Valid") throw new NotMappedError("branches.getCurrentBranchReference", tip.kind)
      const { ref, name, remote, sha, upstream } = branchOf(repoPath, tip.branch)
      return { refType: "branch", repoPath, ref, name, remote, sha, upstream }
    }
  }),
  graph: () => ({
    // graph::graph（Tauri graph，应用提交图同一函数，从全部分支、远端跟踪分支、标签、HEAD 与贮藏遍历），
    // 按游标逐页读完。heads/remotes 取行上的结构化分支，
    // 上游取 branch::list，检出所在工作树取 ops::worktrees；id 是 GitLens 的「仓库|引用名去掉 refs/」。
    async getGraph(repoPath: string, rev: string | undefined, options?: object) {
      if (rev != null) throw new NotMappedError("graph.getGraph", "rev")
      unsupported("graph.getGraph", options)
      const rows: GraphRow[] = []
      for (let cursor: GraphCursor | null = null; ;) {
        const page = await ipc.graph(repoPath, GRAPH_BATCH, rows.length, cursor)
        rows.push(...page.rows)
        if (page.done) break
        cursor = page.cursor
      }
      const details = await ipc.branchDetails(repoPath)
      const checkouts = await ipc.worktrees(repoPath)
      const id = (reference: string) => `${repoPath}|${reference.replace(/^refs\//, "")}`
      return {
        repoPath,
        rows: rows.map(row => ({
          sha: row.commit.sha,
          // 贮藏行取 GraphRow.stash（refs/stash reflog 序号）；其余行按父提交个数分 merge / commit，同 GitLens
          kind: row.stash != null ? "stash" : row.commit.parentSHAs.length > 1 ? "merge" : "commit",
          stashNumber: row.stash != null ? String(row.stash) : undefined,
          parents: row.commit.parentSHAs,
          heads: (row.branches ?? [])
            .filter(branch => branch.remote == null)
            .map(branch => {
              const name = branch.reference.replace(/^refs\/heads\//, "")
              const info = details.find(detail => detail.reference === branch.reference)
              const worktree = checkouts.find(checkout => checkout.branch === name)
              return {
                id: id(branch.reference),
                name,
                isCurrentHead: row.head === name,
                upstream:
                  info?.upstream && info.upstreamRef ? { name: info.upstream, id: id(info.upstreamRef) } : undefined,
                worktree: worktree ? { path: worktree.path, isDefault: worktree.main } : undefined
              }
            }),
          remotes: (row.branches ?? []).flatMap(branch =>
            branch.remote == null
              ? []
              : [
                  {
                    id: id(branch.reference),
                    owner: branch.remote,
                    name: branch.reference.slice(`refs/remotes/${branch.remote}/`.length)
                  }
                ]
          )
        }))
      }
    }
  })
}

export class CliGitProvider {
  constructor(_options: { context?: unknown; locator?: unknown; gitOptions?: unknown }) {
    const all: Record<string, () => object> = subProviders
    const operations: Record<string, () => object> = operationSubProviders
    const provider: Record<string, unknown> = Object.fromEntries(
      [...new Set([...Object.keys(all), ...Object.keys(operations)])].map(name => [
        name,
        guarded(name, { ...all[name]?.(), ...operations[name]?.() })
      ])
    )
    Object.assign(this, provider)
    return guarded("CliGitProvider", this)
  }

  // The bridge spawns one process per call, so there is nothing to release.
  dispose() {}

  // branch::clone_output（应用克隆同一函数）克隆到 parentPath/folderName。runOptions.env 作为进程环境传给桥，
  // 生产 git 子进程同样继承应用环境。没有 folderName 时 GitLens 自动编号目录，GitCub 由用户选路径，不映射。
  async clone(url: string, parentPath: string, options?: { folderName?: string }, runOptions?: RunOptions) {
    unsupported("clone", runOptions, ["env"])
    if (!options?.folderName) throw new NotMappedError("clone", "default folder numbering")
    const path = join(parentPath, options.folderName)
    const result = call("clone", { url, path, options: {} }, runOptions?.env)
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return path
  }

  // system::init_repo（应用新建仓库同一函数）；省略 defaultBranch 时桥用应用默认的 main。
  async init(targetPath: string, options?: { defaultBranch?: string; bare?: boolean }) {
    unsupported("init", options, ["defaultBranch"])
    call("init", { repo: targetPath, branch: options?.defaultBranch })
  }
}

export function findGitPath(): never {
  throw new NotMappedError("findGitPath", "GitCub resolves git inside the Rust bridge")
}
export function createCliGitService(): never {
  throw new NotMappedError("createCliGitService")
}
export function verifyBaseRemeasure(): never {
  throw new NotMappedError("verifyBaseRemeasure")
}

// helpers.ts only configures log channels; GitCub's bridge has no GitLens logger to route them to.
export const Logger = {
  configure(_provider: unknown) {}
}

// ── status / stash / pausedOperations / branches / commits suites ─────────────────────────────────────────────
type NativeChange = {
  path: string
  kind: "unstaged" | "staged" | "both" | "untracked"
  change: "added" | "modified" | "deleted" | "renamed" | "copied" | "conflicted"
  oldPath: string | null
}
type NativeOperation = "merge" | "rebase" | "cherry-pick" | "revert"
type NativeStatus = { branch: string | null; changes: NativeChange[]; operation: NativeOperation | null }
type NativeStashEntry = { name: string; sha: string; message: string }
type NativeCommitInfo = {
  sha: string
  summary: string
  body: string
  authorName: string
  authorEmail: string
  time: number
  parentSHAs: string[]
}
type WorkingChangesOptions = { staged?: boolean; unstaged?: boolean; untracked?: boolean }

// status::status（应用状态栏与变更列表同一函数）。
function nativeStatus(repoPath: string): NativeStatus {
  return call("status", { repo: repoPath })
}

// FileChange → GitStatusFile.status 字母：未跟踪 '?'、冲突 'U'，其余取改动类型。
const statusLetters = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", conflicted: "U" } as const
function statusFile(repoPath: string, change: NativeChange) {
  return {
    repoPath,
    path: change.path,
    originalPath: change.oldPath ?? undefined,
    status: change.kind === "untracked" ? "?" : statusLetters[change.change]
  }
}

// FileChange.kind → GitLens 三类工作区改动是否存在；both 同时算已暂存与未暂存。
function workingChangesState(repoPath: string) {
  const kinds = new Set(nativeStatus(repoPath).changes.map(change => change.kind))
  return {
    staged: kinds.has("staged") || kinds.has("both"),
    unstaged: kinds.has("unstaged") || kinds.has("both"),
    untracked: kinds.has("untracked")
  }
}

// CommitInfo → GitCommit 的 sha/message/author/parents；message 是 summary 加正文（GitLens 的完整提交信息）。
function commit(repoPath: string, info: NativeCommitInfo) {
  return {
    repoPath,
    sha: info.sha,
    message: info.body ? `${info.summary}\n\n${info.body}` : info.summary,
    author: { name: info.authorName, email: info.authorEmail, date: new Date(info.time * 1000) },
    parents: info.parentSHAs
  }
}

Object.assign(subProviders, {
  status: () => ({
    // force 只绕过 GitLens 的状态缓存，GitCub 每次都重新读取；未跟踪文件固定逐个列出（Desktop
    // --untracked-files=all），所以只接受 untracked: 'all'。
    async getStatus(repoPath: string, options?: { force?: boolean; untracked?: string }) {
      unsupported("status.getStatus", options, ["force", "untracked"])
      if (options?.untracked !== undefined && options.untracked !== "all")
        throw new NotMappedError("status.getStatus", `untracked: ${options.untracked}`)
      const status = nativeStatus(repoPath)
      return {
        repoPath,
        branch: status.branch ?? undefined,
        files: status.changes.map(change => statusFile(repoPath, change))
      }
    },
    async getUntrackedFiles(repoPath: string, options?: object, cancellation?: AbortSignal) {
      unsupported("status.getUntrackedFiles", options)
      if (cancellation !== undefined) throw new NotMappedError("status.getUntrackedFiles", "cancellation")
      return nativeStatus(repoPath)
        .changes.filter(change => change.kind === "untracked")
        .map(change => statusFile(repoPath, change))
    },
    async getWorkingChangesState(repoPath: string, options?: object, cancellation?: AbortSignal) {
      unsupported("status.getWorkingChangesState", options)
      if (cancellation !== undefined) throw new NotMappedError("status.getWorkingChangesState", "cancellation")
      return workingChangesState(repoPath)
    },
    // GitLens 的三个开关默认都为 true，只看打开的那几类。
    async hasWorkingChanges(repoPath: string, options?: WorkingChangesOptions, cancellation?: AbortSignal) {
      unsupported("status.hasWorkingChanges", options, ["staged", "unstaged", "untracked"])
      if (cancellation !== undefined) throw new NotMappedError("status.hasWorkingChanges", "cancellation")
      const state = workingChangesState(repoPath)
      return (
        (options?.staged !== false && state.staged) ||
        (options?.unstaged !== false && state.unstaged) ||
        (options?.untracked !== false && state.untracked)
      )
    }
  }),
  stash: () => ({
    // ops::stashes（应用贮藏列表同一函数，`log -g refs/stash`）→ GitStashCommit 的 sha/stashName/message，
    // message 用 reflog 主题原文。
    async getStash(repoPath: string, options?: object) {
      unsupported("stash.getStash", options)
      const stashes: NativeStashEntry[] = call("stash/list", { repo: repoPath })
      return {
        repoPath,
        stashes: new Map(
          stashes.map(stash => [stash.sha, { repoPath, sha: stash.sha, stashName: stash.name, message: stash.message }])
        )
      }
    },
    // ops::stash_push（工具栏贮藏同一函数：未跟踪文件先 add，再 `stash push -m !!GitHub_Desktop<分支>`）。
    // Desktop 的贮藏只有这一种：消息固定为分支标记，调用方的 message 不进入贮藏；路径限定与
    // keepIndex / onlyStaged / includeUntracked 没有对应，一律不映射。
    async saveStash(repoPath: string, _message?: string, pathspecs?: string[], options?: object) {
      if (pathspecs !== undefined) throw new NotMappedError("stash.saveStash", "pathspecs")
      unsupported("stash.saveStash", options)
      const branch = nativeStatus(repoPath).branch
      if (branch == null) throw new NotMappedError("stash.saveStash", "detached HEAD")
      call("stash/push", { repo: repoPath, branch })
    },
    // ops::pop_stash_sha（应用「恢复」贮藏同一函数：按 sha 找到自家条目后 `stash pop --quiet`）。Desktop 只有
    // 恢复（pop）与丢弃，没有保留条目的 apply，deleteAfter 以外的形态不映射。冲突与否由随后的生产状态给出，同 merge。
    async applyStash(repoPath: string, stashName: string, options?: { deleteAfter?: boolean }) {
      unsupported("stash.applyStash", options, ["deleteAfter"])
      if (!options?.deleteAfter) throw new NotMappedError("stash.applyStash", "apply without deleteAfter")
      const stashes: NativeStashEntry[] = call("stash/list", { repo: repoPath })
      const entry = stashes.find(stash => stash.name === stashName)
      if (!entry) throw new NotMappedError("stash.applyStash", `unknown stash ${stashName}`)
      call("stash/pop", { repo: repoPath, sha: entry.sha })
      const conflicts = nativeStatus(repoPath).changes.filter(change => change.change === "conflicted")
      return conflicts.length > 0
        ? { conflicted: true, conflicts: conflicts.map(change => ({ path: change.path })) }
        : { conflicted: false }
    }
  }),
  pausedOps: () => ({
    // status::status 的 operation（ops::in_progress，应用识别进行中的合并/变基/摘取/回滚同一判断）。
    async hasPausedOperation(repoPath: string) {
      return nativeStatus(repoPath).operation != null
    },
    // 同一判断给出的操作类型；GitCub 没有 GitLens 状态模型里的 HEAD/incoming/steps，这些字段缺省。
    async getPausedOperationStatus(repoPath: string, options?: { force?: boolean }) {
      unsupported("pausedOps.getPausedOperationStatus", options, ["force"])
      const operation = nativeStatus(repoPath).operation
      return operation == null ? undefined : { repoPath, type: operation }
    },
    // ops::continue_operation（应用「继续」同一函数）。GitCub 的继续总以 GIT_EDITOR=: 无头完成并保留 git 备好的
    // 提交信息，对应 GitLens 的 messageEditor: 'true'；其它编辑器与 skip/allowEmpty 不映射。
    async continuePausedOperation(repoPath: string, options?: { messageEditor?: string }) {
      unsupported("pausedOps.continuePausedOperation", options, ["messageEditor"])
      if (options?.messageEditor !== "true")
        throw new NotMappedError("pausedOps.continuePausedOperation", "GitCub continues headlessly only")
      const operation = nativeStatus(repoPath).operation
      if (operation == null) throw new NotMappedError("pausedOps.continuePausedOperation", "no paused operation")
      call("operation/continue", { repo: repoPath, pausedOperation: operation })
    }
  }),
  commits: () => ({
    // history::log（应用历史列表同一函数，从 HEAD 分页读取）。多读一条判断 hasMore，与 GitLens 的做法相同。
    async getLog(repoPath: string, rev?: string, options?: { limit?: number }) {
      unsupported("commits.getLog", options, ["limit"])
      if (rev !== undefined) throw new NotMappedError("commits.getLog", "rev")
      if (options?.limit == null) throw new NotMappedError("commits.getLog", "unlimited")
      const infos: NativeCommitInfo[] = call("history", { repo: repoPath, limit: options.limit + 1 })
      const commits = infos.slice(0, options.limit).map(info => commit(repoPath, info))
      return {
        repoPath,
        commits: new Map(commits.map(value => [value.sha, value])),
        count: commits.length,
        limit: options.limit,
        hasMore: infos.length > options.limit
      }
    },
    // history::query（Desktop getCommits，`log --max-count=1 --end-of-options <rev>`）的第一条。
    async getCommit(repoPath: string, rev: string) {
      const [info]: NativeCommitInfo[] = call("history/query", {
        repo: repoPath,
        revision: rev,
        limit: 1,
        additional: []
      })
      return info ? commit(repoPath, info) : undefined
    }
  })
})
