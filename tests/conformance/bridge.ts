import type { discardSelection } from "../../src/lib/stage"
import type { StashEntry, Worktree } from "../../src/models/app-state"
import type { Branch } from "../../src/models/branch"
import type { CommitFile } from "../../src/models/history"
import type { FileChange } from "../../src/models/repo-status"

type NativeBranch = { reference: string; sha: string; remote: boolean; name: string }
type NativeStash = StashEntry & { branchName: string | null; tree: string; parents: string[] }
type NativeBlameCommit = { author: { date: number }; committer: { date: number } }

import { spawn, spawnSync } from "node:child_process"
import { normalize, resolve } from "node:path"

import { GitStatus } from "@gitlens/git/models/status.js"
import { GitStatusFile } from "@gitlens/git/models/statusFile.js"
import { normalizePath as normalizeGitLensPath } from "@gitlens/utils/path.js"

import { getCommits as productionCommits } from "../../src/lib/commit-history"
import { appStatus } from "../../src/lib/desktop-status"
import { parseRemote as desktopParseRemote } from "../../src/upstream/lib/remote-parsing"
import { DiffSelection, DiffSelectionType } from "../../src/upstream/models/diff"
import { WorkingDirectoryFileChange, WorkingDirectoryStatus } from "../../src/upstream/models/status"
import { exec } from "./git-process"

type NativeGitLensStatus = {
  branch: string
  sha: string
  files: {
    x?: string
    y?: string
    path: string
    originalPath?: string
    submodule?: { oid: string; previousOid: string }
  }[]
  upstream?: { name: string; missing: boolean; state: { ahead: number; behind: number } }
}

export const executable =
  process.env.GITCUB_CONFORMANCE_BIN ??
  resolve(
    import.meta.dirname,
    `../../src-tauri/target/debug/examples/conformance${process.platform === "win32" ? ".exe" : ""}`
  )
export function call(operation: string, args: Record<string, unknown>, env?: Record<string, string>) {
  const result = spawnSync(executable, {
    env: { ...process.env, ...env },
    input: JSON.stringify({ operation, ...args }),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 30000
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `Rust bridge exited ${result.status}`)
  const output = JSON.parse(result.stdout)
  if (output?.error) throw new Error(output.error)
  return output
}

// 只恢复跨 JSON 边界丢失的 Map/Date/undefined，不在适配层实现 blame 算法。
export function parseGitBlame(repo: string, data?: string, user?: object, modifiedTime?: number) {
  const result = call("blame", { repo, data, user, modifiedTime })
  if (result === null) return undefined
  result.authors = new Map(result.authors)
  const commits: Record<string, NativeBlameCommit> = result.commits
  result.commits = new Map(
    Object.entries(commits).map(([key, value]) => [
      key,
      {
        ...value,
        author: { ...value.author, date: new Date(value.author.date) },
        committer: { ...value.committer, date: new Date(value.committer.date) }
      }
    ])
  )
  return result
}

// Desktop API 的参数形状适配；所有 Git/.gitignore 被测行为都在 Rust。
export async function readGitIgnoreAtRoot(repo: { path: string }) {
  return call("gitignore/read", { repo: repo.path })
}
export async function saveGitIgnore(repo: { path: string }, text: string) {
  return call("gitignore/save", { repo: repo.path, text })
}
export function escapeGitSpecialCharacters(text: string) {
  return call("gitignore/escape", { text })
}
export async function appendIgnoreRule(repo: { path: string }, patterns: string | string[]) {
  return call("gitignore/append-rules", { repo: repo.path, patterns: Array.isArray(patterns) ? patterns : [patterns] })
}
export async function appendIgnoreFile(repo: { path: string }, paths: string | string[]) {
  return call("gitignore/append-files", { repo: repo.path, paths: Array.isArray(paths) ? paths : [paths] })
}
export async function getStatusOrThrow(repo: { path: string }) {
  const result = call("status", { repo: repo.path })
  const tip = call("branch/tip", { repo: repo.path })
  return {
    ...result,
    currentBranch: result.branch ?? undefined,
    rebaseInternalState: call("rebase/state", { repo: repo.path }),
    currentTip: tip.kind === "Valid" ? tip.branch.sha : tip.kind === "Detached" ? tip.currentSha : undefined,
    workingDirectory: WorkingDirectoryStatus.fromFiles(
      result.changes.map(
        (file: FileChange) =>
          new WorkingDirectoryFileChange(
            file.path,
            appStatus(file),
            DiffSelection.fromInitialSelection(DiffSelectionType.All)
          )
      )
    )
  }
}

export async function getRemotes(repo: { path: string }) {
  return call("remote/list", { repo: repo.path }).map(([name, url]: string[]) => ({ name, url }))
}
export async function getRemoteURL(repo: { path: string }, name: string) {
  return call("remote/get-url", { repo: repo.path, name })
}
export async function updateRemoteHEAD(repo: { path: string }, remote: { name: string }, _background: boolean) {
  return call("remote/update-head", { repo: repo.path, name: remote.name })
}
export async function addRemote(repo: { path: string }, name: string, url: string) {
  return call("remote/add", { repo: repo.path, name, url })
}
export async function setRemoteURL(repo: { path: string }, name: string, url: string) {
  return call("remote/set-url", { repo: repo.path, name, url })
}
export async function removeRemote(repo: { path: string }, name: string) {
  return call("remote/remove", { repo: repo.path, name })
}

export async function initGitRepository(path: string) {
  return call("init", { repo: path })
}

export function parseGitWorktrees(data: string | undefined, _repoPath: string, branches: { name: string }[]) {
  // GitLens c1f6e5f3c GitWorktree: `type`, the porcelain `branchName`, and `branch` only when a known
  // GitBranch matches; Rust keeps its `kind`/`branch` field names for the app.
  return call("worktree/parse", { data }).map((wt: Worktree) => ({
    ...wt,
    type: wt.kind,
    branchName: wt.branch ?? undefined,
    branch: wt.branch == null ? undefined : branches?.find(branch => branch.name === wt.branch)
  }))
}

// GitLens c1f6e5f3c statusParser: Rust splits every porcelain v1/v2 line into the raw x/y codes, paths, header
// fields and submodule oids; the original GitStatus/GitStatusFile snapshots turn those into statuses, the
// detached-HEAD label and file uris, exactly where the upstream parser hands over to them.
export function parseGitStatus(
  data: string,
  repoPath: string,
  porcelainVersion: number,
  getUri?: (path: string) => unknown
) {
  const status: NativeGitLensStatus | null = call("status/parse-gitlens", { data, porcelainVersion })
  if (status === null) return undefined
  const files = status.files.map(
    file =>
      new GitStatusFile(repoPath, file.x, file.y, file.path, getUri?.(file.path), file.originalPath, file.submodule)
  )
  return new GitStatus(normalizeGitLensPath(repoPath), status.branch, status.sha, files, status.upstream)
}

export function foldMatchingIgnored(records: Iterable<string>): string[] {
  return call("status/fold-ignored", { records: [...records] })
}

// GitLens c1f6e5f3c search.utils: Rust `search_query` parses the query and builds the git arguments; the bridge
// only turns the serialised ordered entries back into the upstream Map/Set shapes (absent keys stay undefined).
type NativeOperations = [string, string[]][]
type GitLensSearchQuery = { query: string; [flag: string]: unknown }
type GitLensParsedSearchQuery = { operations: Map<string, Set<string>>; errors?: string[]; operatorRanges?: unknown[] }
const toOperations = (entries: NativeOperations) =>
  new Map(entries.map(([operator, values]) => [operator, new Set(values)]))
export function parseSearchQuery(search: GitLensSearchQuery, validate = false): GitLensParsedSearchQuery {
  const result = call("search/parse", { search, validate })
  return { ...result, operations: toOperations(result.operations) }
}
export function parseSearchQueryGitCommand(search: GitLensSearchQuery, currentUser?: { name?: string }) {
  const result = call("search/git-command", { search, currentUser: currentUser ?? null })
  return {
    ...result,
    shas: result.shas == null ? undefined : new Set<string>(result.shas),
    operations: toOperations(result.operations)
  }
}
export function rebuildSearchQueryFromParsed(parsed: GitLensParsedSearchQuery): string {
  return call("search/rebuild", {
    parsed: { operations: [...parsed.operations].map(([operator, values]) => [operator, [...values]]) }
  })
}
export function getSearchQueryComparisonKey(search: GitLensSearchQuery): string {
  return call("search/comparison-key", { search })
}
export function areSearchQueriesEqual(a?: GitLensSearchQuery, b?: GitLensSearchQuery): boolean {
  return call("search/equal", { a: a ?? null, b: b ?? null })
}
export async function getStatus(repo: { path: string }) {
  if (call("repository/type", { repo: repo.path }).kind === "missing") return null
  return { ...(await getStatusOrThrow(repo)), exists: true }
}

export async function getRepositoryType(repo: string) {
  return call("repository/type", { repo })
}
export async function addSafeDirectory(repo: string) {
  return call("config/safe", { repo })
}
export async function getConfigValue(repo: { path: string }, key: string, local = false) {
  return call("config/get", { repo: repo.path, key, local })
}
const configEnvironment = (env?: { HOME: string }) =>
  env ? { GIT_CONFIG_GLOBAL: resolve(env.HOME, ".gitconfig") } : undefined
export async function getGlobalConfigValue(key: string, env?: { HOME: string }) {
  return call("config/get", { key }, configEnvironment(env))
}
export async function getGlobalBooleanConfigValue(key: string, env?: { HOME: string }) {
  const value = call("config/get", { key, boolean: true }, configEnvironment(env))
  return value === null ? null : value !== "false"
}
export async function setGlobalConfigValue(key: string, value: string, env?: { HOME: string }) {
  return call("config/set", { key, value }, configEnvironment(env))
}
export async function getGlobalConfigPath(env?: { HOME: string }) {
  return call("config/path", {}, configEnvironment(env))
}
export { executeGit as git } from "../../src/lib/git-execution"
export function parseConfigLockFilePathFromError(result: { path: string; stderr: string }) {
  return call("git/config-lock-path", { repo: result.path, stderr: result.stderr })
}

export async function getCommits(
  repo: { path: string },
  revision: string,
  limit?: number,
  skip?: number,
  additional: string[] = []
) {
  return (await productionCommits(repo, revision, limit, skip, additional)).map(commit =>
    Object.assign(commit, { parentCount: commit.parentSHAs.length })
  )
}
export async function getTipOrError(repo: { path: string }) {
  const commits = await getCommits(repo, "HEAD", 1)
  if (!commits[0]) throw new Error("Missing HEAD")
  return commits[0]
}
export async function revertCommit(
  repo: { path: string },
  commit: { sha: string; parentCount: number },
  _account: unknown
) {
  return call("revert", { repo: repo.path, sha: commit.sha, merge: commit.parentCount > 1 })
}

export const RebaseResult = {
  CompletedWithoutError: "CompletedWithoutError",
  ConflictsEncountered: "ConflictsEncountered",
  Error: "Error",
  AlreadyUpToDate: "AlreadyUpToDate",
  OutstandingFilesNotStaged: "OutstandingFilesNotStaged",
  Aborted: "Aborted"
}
export async function getCommit(repo: { path: string }, revision: string) {
  return (await getCommits(repo, revision, 1))[0] ?? null
}
export async function getChangedFiles(repo: { path: string }, sha: string) {
  return {
    files: call("history/files", { repo: repo.path, sha }).map((file: CommitFile) => ({
      ...file,
      status: {
        kind: { added: "New", modified: "Modified", deleted: "Deleted", renamed: "Renamed", copied: "Copied" }[
          file.kind as string
        ],
        submoduleStatus: file.submodule
          ? { commitChanged: true, modifiedChanges: false, untrackedChanges: false }
          : undefined,
        ...(file.oldPath !== null
          ? { oldPath: file.oldPath, renameIncludesModifications: file.renameIncludesModifications }
          : {})
      }
    }))
  }
}
export async function getRebaseInternalState(repo: { path: string }) {
  return call("rebase/state", { repo: repo.path })
}
export async function squash(
  repo: { path: string },
  commits: { sha: string }[],
  onto: { sha: string },
  base: string | null,
  message: string
) {
  return call("squash", { repo: repo.path, shas: commits.map(c => c.sha), onto: onto.sha, base, message })
}
export async function reorder(
  repo: { path: string },
  commits: { sha: string }[],
  before: { sha: string } | null,
  base: string | null
) {
  return call("reorder", { repo: repo.path, shas: commits.map(c => c.sha), before: before?.sha, base })
}
export async function continueRebase(
  repo: { path: string },
  files: { path: string }[],
  resolutions = new Map<string, string>(),
  options?: { gitEditor?: string; progressCallback?: (progress: unknown) => void }
) {
  const outcome = call("rebase/continue-detailed", {
    repo: repo.path,
    paths: files.map(file => file.path),
    resolutions: [...resolutions],
    editor: options?.gitEditor
  })
  outcome.progress.forEach((progress: unknown) => options?.progressCallback?.(progress))
  return outcome.result
}

export function parseGitLsFilesStaged(data: string | undefined, _singleEntry: boolean) {
  return call("index/staged", { data })
}
export function parseGitConflictFiles(data: string | undefined, repo: string) {
  return call("index/conflicts", { data, repo })
}

// Shape-only adapters. Tip/branch decisions are made by production Rust.
export const TipState = { Unknown: "Unknown", Unborn: "Unborn", Detached: "Detached", Valid: "Valid" }
export const BranchType = { Local: 0, Remote: 1 }
export { shell } from "../../src/lib/app-shell"
export { TestStatsStore } from "./upstream/desktop/helpers/test-stats-store"
function branchShape(branch: NativeBranch) {
  return {
    ...branch,
    ref: branch.reference,
    tip: { sha: branch.sha },
    type: branch.remote ? BranchType.Remote : BranchType.Local
  }
}
export { GitStore } from "../../src/lib/stores/git-store"
export function assertNonNullable(value: unknown, message: string) {
  if (value === null || value === undefined) throw new Error(message)
}
export async function getBranches(repo: { path: string }, pattern?: string) {
  return call("branch/list", { repo: repo.path, pattern }).map(branchShape)
}
export async function createBranch(repo: { path: string }, name: string, start: string | null, noTrack = false) {
  return call("branch/create", { repo: repo.path, name, start, noTrack })
}
export async function deleteLocalBranch(repo: { path: string }, name: string) {
  return call("branch/delete", { repo: repo.path, name })
}
export async function deleteRemoteBranch(repo: { path: string }, remote: { name: string }, name: string) {
  return call("branch/delete-remote", { repo: repo.path, remote: remote.name, name })
}
export async function getBranchesPointedAt(repo: { path: string }, revision: string) {
  return call("branch/pointed", { repo: repo.path, revision })
}
export async function checkoutBranch(
  repo: { path: string },
  branch: Branch,
  _remote: unknown,
  _progress?: unknown,
  allowFileProtocol = false
) {
  return call("branch/checkout", {
    repo: repo.path,
    name: branch.type === BranchType.Remote ? branch.nameWithoutRemote : branch.name,
    remoteRef: branch.type === BranchType.Remote ? branch.ref : null,
    allowFileProtocol
  })
}
export function formatAsLocalRef(name: string) {
  return call("branch/local-ref", { name })
}
export async function getSymbolicRef(repo: { path: string }, name: string) {
  return call("branch/symbolic", { repo: repo.path, name })
}
export const MergeResult = { Success: "Success", AlreadyUpToDate: "AlreadyUpToDate", Failed: "Failed" }
export async function merge(
  repo: { path: string },
  branch: string,
  options?: { squash?: boolean; noVerify?: boolean }
) {
  return call("merge", { repo: repo.path, branch, ...options })
}
export async function getMergeBase(repo: { path: string }, first: string, second: string) {
  return call("merge/base", { repo: repo.path, first, second })
}
export async function abortMerge(repo: { path: string }) {
  return call("merge/abort", { repo: repo.path })
}
export async function getFilesWithConflictMarkers(repo: string) {
  return new Map(Object.entries(call("conflict/markers", { repo })))
}

export async function getBranchesDifferingFromUpstream(repo: { path: string }) {
  return call("branch/differing", { repo: repo.path })
}

export { getWorkingDirectoryDiff } from "./diff.ts"
export const ManualConflictResolution = { ours: "ours", theirs: "theirs" }
export { isConflictedFile } from "../../src/upstream/lib/status"

// Desktop's historical API parses this token from Git's actual stdout, including
// its '(root-commit)' quirk. Do not substitute a made-up commit id in the bridge.
const parseCommitSHA = (stdout: string) => stdout.split("]")[0].split(" ")[1]
export async function createCommit(
  repo: { path: string },
  message: string,
  files: WorkingDirectoryFileChange[],
  options: { allowEmpty?: boolean; noVerify?: boolean; signOff?: boolean } = {}
) {
  const { applySelection } = await import("../../src/lib/stage")
  const status = call("status", { repo: repo.path })
  await applySelection(
    repo.path,
    files.map(file => {
      const raw = status.changes.find((raw: { path: string }) => raw.path === file.path)
      if (!raw) throw new Error(`Missing production status for ${file.path}`)
      return { file: raw, include: file.selection.getSelectionType(), selection: file.selection }
    })
  )
  return parseCommitSHA(
    call("commit", {
      repo: repo.path,
      message,
      options: { allowEmpty: options.allowEmpty, skipHooks: options.noVerify, signOff: options.signOff }
    })
  )
}
export async function createMergeCommit(
  repo: { path: string },
  files: WorkingDirectoryFileChange[],
  resolutions = new Map<string, string>()
) {
  return parseCommitSHA(
    call("commit/merge", { repo: repo.path, paths: files.map(f => f.path), resolutions: [...resolutions] })
  )
}

export function parseRemote(url: string) {
  const remote = call("remote/parse", { url })
  return remote === null ? null : { ...remote, hostname: remote.host }
}

export const GitResetMode = { Hard: "hard", Mixed: "mixed", Soft: "soft" }
export async function reset(repo: { path: string }, mode: string, target: string) {
  return call("reset", { repo: repo.path, mode, target })
}
export async function resetPaths(repo: { path: string }, mode: string, target: string, paths: string[]) {
  return call("reset/paths", { repo: repo.path, mode, target, paths })
}
export async function addConflictedFile(repo: { path: string }, file: { path: string }) {
  return call("conflict/add", { repo: repo.path, file: file.path })
}
export async function getResolutionDiff(
  repo: { path: string },
  file: string,
  target: { content: string } | { stage: string },
  hideWhitespace = false
) {
  const { getResolutionDiff } = await import("../../src/lib/diff")
  return getResolutionDiff(repo.path, file, target as { content: string }, hideWhitespace)
}
export async function discardChangesFromSelection(
  repo: { path: string },
  file: string,
  diff: Parameters<typeof discardSelection>[2],
  selection: DiffSelection
) {
  const { discardSelection } = await import("../../src/lib/stage")
  return discardSelection(repo.path, file, diff, selection)
}

export async function createTag(repo: { path: string }, name: string, sha: string) {
  return call("tags/create", { repo: repo.path, name, sha })
}
export async function deleteTag(repo: { path: string }, name: string) {
  return call("tags/delete", { repo: repo.path, name })
}
export async function getAllTags(repo: { path: string }) {
  return new Map(Object.entries(call("tags/list", { repo: repo.path })))
}
export async function fetchTagsToPush(repo: { path: string }, remote: { name: string }, branch: string) {
  return call("tags/unpushed", { repo: repo.path, remote: remote.name, branch })
}
export { push } from "../../src/lib/push"

function desktopWorktree(wt: Worktree) {
  return {
    path: normalize(wt.path),
    head: wt.sha ?? "",
    branch: wt.branch === null ? null : `refs/heads/${wt.branch}`,
    isDetached: wt.kind === "detached",
    type: wt.main ? "main" : "linked",
    isLocked: !!wt.locked,
    isPrunable: !!wt.prunable
  }
}
export function parseWorktreePorcelainOutput(data: string) {
  return call("worktree/parse", { data }).map(desktopWorktree)
}
export async function listWorktrees(repo: { path: string } | string) {
  return call("worktree/list", { repo: typeof repo === "string" ? repo : repo.path }).map(desktopWorktree)
}
export async function listWorktreesFromGitDir(gitDir: string) {
  return call("worktree/git-dir", { gitDir }).map(desktopWorktree)
}
export async function resolveMainWorktreePath(repo: { path: string; gitDir?: string; mainWorktreePath?: string }) {
  return call("worktree/main-path", { repo: repo.path, gitDir: repo.gitDir, mainPath: repo.mainWorktreePath })
}
// Production Rust resolves the main worktree and builds the command; the suite's
// recorded dugite exec then runs it so the original cwd assertion observes it.
export async function moveWorktree(repo: { path: string }, oldPath: string, newPath: string) {
  const { cwd, args } = call("worktree/move-command", { repo: repo.path, oldPath, newPath })
  const result = await exec(args, cwd)
  if (result.exitCode !== 0) throw new Error(result.stderr)
}

export async function getGitDescription(repo: string) {
  return call("repository/description", { repo })
}
export async function getRecentBranches(repo: { path: string }, limit: number) {
  return call("reflog/recent", { repo: repo.path, limit })
}
export async function getBranchCheckouts(repo: { path: string }, after: Date) {
  return new Map(
    Object.entries(call("reflog/checkouts", { repo: repo.path, after: after.toISOString() })).map(([name, date]) => [
      name,
      new Date(date as string)
    ])
  )
}
export async function renameBranch(repo: { path: string }, branch: { name: string }, name: string) {
  return call("branch/rename", { repo: repo.path, from: branch.name, to: name })
}
export async function listSubmodules(repo: { path: string }) {
  return call("submodules/list", { repo: repo.path })
}
export async function resetSubmodulePaths(repo: { path: string }, paths: string[]) {
  return call("submodules/reset", { repo: repo.path, paths })
}
export async function formatPatch(repo: { path: string }, base: string, head: string) {
  return call("format/patch", { repo: repo.path, base, head })
}

export async function fastForwardBranches(repo: { path: string }, branches: unknown[]) {
  return call("branch/fast-forward", { repo: repo.path, branches })
}
export async function isUsingLFS(repo: { path: string }) {
  return call("lfs/using", { repo: repo.path })
}
export async function isTrackedByLFS(repo: { path: string }, file: string) {
  return call("lfs/tracked", { repo: repo.path, file })
}
export async function filesNotTrackedByLFS(repo: { path: string }, paths: string[]) {
  return call("lfs/untracked", { repo: repo.path, paths })
}

export const StashedChangesLoadStates = { NotLoaded: "NotLoaded", Loading: "Loading", Loaded: "Loaded" }
function desktopStash(entry: NativeStash) {
  return {
    name: `refs/${entry.name}`,
    branchName: entry.branchName,
    stashSha: entry.sha,
    tree: entry.tree,
    parents: entry.parents,
    files: { kind: "NotLoaded" }
  }
}
export async function getStashes(repo: { path: string }) {
  const entries = call("stash/list", { repo: repo.path })
  return {
    desktopEntries: entries.filter((entry: NativeStash) => entry.ours).map(desktopStash),
    stashEntryCount: entries.length
  }
}
export function createDesktopStashMessage(branch: string) {
  return call("stash/message", { branch })
}
export async function createDesktopStashEntry(repo: { path: string }, branch: string, files: { path: string }[]) {
  return call("stash/create", { repo: repo.path, branch, paths: files.map(file => file.path) })
}
export async function getLastDesktopStashEntryForBranch(repo: { path: string }, branch: string) {
  const entry = call("stash/last", { repo: repo.path, branch })
  return entry === null ? null : desktopStash(entry)
}
export async function dropDesktopStashEntry(repo: { path: string }, sha: string) {
  return call("stash/drop", { repo: repo.path, sha })
}
export async function popStashEntry(repo: { path: string }, sha: string) {
  return call("stash/pop", { repo: repo.path, sha })
}

export { fetch, pull } from "../../src/lib/fetch"
export { GitCommandError as GitError } from "../../src/lib/clone"
export async function fetchRefspec(repo: { path: string }, remote: { name: string }, refspec: string) {
  return call("remote/fetch-refspec", { repo: repo.path, remote: remote.name, refspec })
}
export async function addWorktree(
  repo: { path: string },
  path: string,
  options: { createBranch?: string; commitish?: string } = {}
) {
  return call("worktree/add", { repo: repo.path, path, ...options })
}
export async function getRefOrError(repo: { path: string }, revision: string) {
  const commit = await getCommit(repo, revision)
  if (commit === null) throw new Error(`Missing ref ${revision}`)
  return commit
}
export function revSymmetricDifference(ours: string, theirs: string) {
  return call("revision/symmetric", { ours, theirs })
}
export async function getAheadBehind(repo: { path: string }, range: string) {
  const counts = call("revision/ahead-behind", { repo: repo.path, range })
  return counts === null ? null : { ahead: counts[0], behind: counts[1] }
}

export async function getBranchMergeBaseChangedFiles(repo: { path: string }, from: string, to: string, latest: string) {
  const result = call("history/merge-base-files", { repo: repo.path, from, to, latest })
  if (result === null) return null
  return {
    ...result,
    files: result.files.map((file: CommitFile) => ({
      ...file,
      commitish: result.commitish,
      parentCommitish: result.parentCommitish,
      status: {
        kind: { added: "New", modified: "Modified", deleted: "Deleted", renamed: "Renamed", copied: "Copied" }[
          file.kind as string
        ],
        submoduleStatus: file.submodule
          ? { commitChanged: true, modifiedChanges: false, untrackedChanges: false }
          : undefined,
        ...(file.oldPath !== null
          ? { oldPath: file.oldPath, renameIncludesModifications: file.renameIncludesModifications }
          : {})
      }
    }))
  }
}
export async function getBranchMergeBaseDiff(
  repo: { path: string },
  file: { path: string; status: { oldPath?: string } },
  from: string,
  to: string,
  hideWhitespace = false,
  _latest?: string
) {
  const { getBranchMergeBaseDiff } = await import("../../src/lib/diff")
  return getBranchMergeBaseDiff(repo.path, file.path, from, to, file.status.oldPath, hideWhitespace)
}
export async function getBlobContents(repo: { path: string }, revision: string, file: string) {
  try {
    return Buffer.from(call("blob", { repo: repo.path, revision, file }))
  } catch (error) {
    ;(error as Error).name = "GitError"
    throw error
  }
}
export async function getPartialBlobContents(repo: { path: string }, revision: string, file: string, length: number) {
  try {
    const data = call("blob/partial", { repo: repo.path, revision, file, length })
    return data === null ? null : Buffer.from(data)
  } catch (error) {
    ;(error as Error).name = "GitError"
    throw error
  }
}
export const getPartialBlobContentsCatchPathNotInRef = getPartialBlobContents
export async function getCommitsInRange(repo: { path: string }, range: string) {
  return call("history/range", { repo: repo.path, range })
}
export async function doMergeCommitsExistAfterCommit(repo: { path: string }, revision: string | null) {
  return call("history/merges", { repo: repo.path, revision })
}

export async function getWorkingDirectoryImage(repo: { path: string }, file: { path: string }) {
  const { getWorkingDirectoryImage } = await import("../../src/lib/diff")
  return getWorkingDirectoryImage(repo.path, file.path)
}
export async function getBlobImage(repo: { path: string }, file: string, revision: string) {
  const { getBlobImage } = await import("../../src/lib/diff")
  return getBlobImage(repo.path, file, revision)
}
export async function getBinaryPaths(repo: { path: string }, revision: string, files: { path: string }[]) {
  return call("diff/binary-paths", { repo: repo.path, revision, paths: files.map(file => file.path) })
}

export async function getBranchOrError(repo: { path: string }, name: string) {
  const branch = (await getBranches(repo)).find((branch: { name: string }) => branch.name === name)
  if (!branch) throw new Error(`Missing branch ${name}`)
  return branch
}
export async function rebase(
  repo: { path: string },
  base: { name: string },
  target: { name: string },
  progressCallback?: (progress: unknown) => void
) {
  const outcome = call("rebase/start", { repo: repo.path, base: base.name, target: target.name })
  outcome.progress.forEach((progress: unknown) => progressCallback?.(progress))
  return outcome.result
}
export async function abortRebase(repo: { path: string }) {
  return call("rebase/abort", { repo: repo.path })
}
export async function getRebaseSnapshot(repo: { path: string }) {
  return call("rebase/snapshot", { repo: repo.path })
}

export const CherryPickResult = {
  CompletedWithoutError: "CompletedWithoutError",
  ConflictsEncountered: "ConflictsEncountered",
  OutstandingFilesNotStaged: "OutstandingFilesNotStaged",
  UnableToStart: "UnableToStart",
  Error: "Error"
}
export async function cherryPick(
  repo: { path: string },
  commits: { sha: string; summary: string }[],
  progressCallback?: (progress: unknown) => void
) {
  const outcome = call("cherry-pick/start", { repo: repo.path, commits })
  outcome.progress.forEach((progress: unknown) => progressCallback?.(progress))
  return outcome.result
}
export async function continueCherryPick(
  repo: { path: string },
  files: { path: string }[],
  resolutions = new Map<string, string>(),
  progressCallback?: (progress: unknown) => void
) {
  const outcome = call("cherry-pick/continue", {
    repo: repo.path,
    paths: files.map(file => file.path),
    resolutions: [...resolutions]
  })
  outcome.progress.forEach((progress: unknown) => progressCallback?.(progress))
  return outcome.result
}
export async function getCherryPickSnapshot(repo: { path: string }) {
  return call("cherry-pick/snapshot", { repo: repo.path })
}
export async function abortCherryPick(repo: { path: string }) {
  return call("cherry-pick/abort", { repo: repo.path })
}
export { revRangeInclusive } from "../../src/lib/revision-range"

export { clone, isGitError } from "../../src/lib/clone"
export async function writeGitAttributes(path: string) {
  return call("git-attributes/write", { repo: path })
}

export async function setConfigValue(repo: { path: string }, key: string, value: string) {
  return call("config/set", { repo: repo.path, key, value })
}

export class GitProgressParser {
  protected parser: unknown
  constructor(steps: { title: string; weight: number }[]) {
    this.parser = call("progress/new", { steps })
  }
  parse(line: string) {
    const response = call("progress/next", { line, parser: this.parser })
    this.parser = response.parser
    return response.result
  }
}
export class CloneProgressParser extends GitProgressParser {
  constructor() {
    super([{ title: "", weight: 1 }])
    this.parser = call("progress/new", { clone: true })
  }
}
export class GitLFSProgressParser {
  private parser: unknown = null
  parse(line: string) {
    const response = call("progress/lfs", { line, parser: this.parser })
    this.parser = response.parser
    return response.result
  }
}
export function parse(line: string) {
  const result = call("progress/parse", { line })
  return result === null ? null : { ...result, total: result.total ?? undefined, percent: result.percent ?? undefined }
}

export async function formatCommitMessage(
  repo: { path: string },
  context: { summary: string; description: string | null; trailers?: { token: string; value: string }[] }
) {
  return call("commit/format", { repo: repo.path, ...context, trailers: context.trailers ?? [] })
}
export async function writeDefaultReadme(path: string, name: string, description?: string) {
  return call("readme/write", { repo: path, name, description })
}

export async function getFileHash(path: string, algorithm: string) {
  const result = call("file/hash", { repo: path, algorithm })
  if (result.failure) throw Object.assign(new Error(result.failure.message), { code: result.failure.code })
  return result.value
}
export async function resolveWithin(root: string, ...segments: string[]) {
  return call("file/resolve", { repo: root, segments })
}
export function encodePathAsUrl(...segments: string[]) {
  return call("file/url", { segments })
}
export function isApplicationBundleFromMetadata(metadata: string) {
  return call("file/bundle", { metadata })
}

export function parseCredential(value: string): Map<string, string> {
  return new Map(call("credential/parse", { value }))
}
export function formatCredential(credential: Map<string, string>): string {
  return call("credential/format", { entries: [...credential] })
}
export function getTempFilePath(name: string): string {
  return call("file/temp", { name })
}
export async function readPartialFile(path: string, start: number, end: number): Promise<Buffer> {
  return Buffer.from(call("file/partial", { repo: path, start, end }))
}

export function formatRebaseValue(value: number): number {
  return call("format/rebase", { value: String(value) })
}
export function getAbsoluteUrl(endpoint: string, path: string): string {
  return call("http/absolute-url", { endpoint, path })
}
export function getDotComAPIEndpoint(): string {
  return call("http/dotcom", {})
}
export function parseAddSSHHostPrompt(prompt: string) {
  return call("ssh/prompt", { prompt })
}

// Transport only: forward native streaming records into the production Tauri Channel API.
export function streamCall(
  args: Record<string, unknown>,
  output: { onmessage: (chunk: import("../../src/lib/terminal-output-decoder").TerminalChunk) => void }
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, { stdio: ["pipe", "pipe", "pipe"] })
    let pending = "",
      stderr = ""
    let response: unknown
    child.stdout.setEncoding("utf8").on("data", text => {
      pending += text
      let newline: number
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        try {
          const value = JSON.parse(line)
          if (value.terminal) output.onmessage(value.terminal)
          else response = value
        } catch (error) {
          child.kill()
          reject(error)
        }
      }
    })
    child.stderr.setEncoding("utf8").on("data", text => {
      stderr += text
    })
    child.on("error", reject)
    child.on("close", code => {
      if (code !== 0) reject(new Error(stderr || `Git bridge exited ${code}`))
      else if (response && typeof response === "object" && "error" in response)
        reject(new Error(String(response.error)))
      else resolve(response)
    })
    child.stdin.end(JSON.stringify({ operation: "git/stream", ...args }))
  })
}

export const parsePorcelainStatus = (data: Uint8Array) => call("status/parse", { data: [...data] })

// GitLens c1f6e5f3c revision.utils / fileStatus.utils / remote.utils / branch.utils：只转发到 Rust 生产函数
// （search_query、raw_diff、remote、branch）。GitCub 只移植了无选项的形态，带选项的调用直接报错，
// 对应的原版用例在 gitlens-unported-blocks.ts 里按标题排除。
const withoutOptions = (name: string, options: unknown[]) => {
  if (options.length > 0) throw new Error(`${name}: options are not ported`)
}
export function isSha(rev: string, ...options: unknown[]): boolean {
  withoutOptions("isSha", options)
  return call("gitlens/is-sha", { rev })
}
export function isShaWithOptionalRevisionSuffix(rev: string): boolean {
  return call("gitlens/is-sha-with-optional-revision-suffix", { rev })
}
export function isUncommitted(rev: string | undefined, ...options: unknown[]): boolean {
  withoutOptions("isUncommitted", options)
  return call("gitlens/is-uncommitted", { rev })
}
export function isUncommittedStaged(rev: string | undefined, ...options: unknown[]): boolean {
  withoutOptions("isUncommittedStaged", options)
  return call("gitlens/is-uncommitted-staged", { rev })
}
export function shortenRevision(rev: string | undefined, ...options: unknown[]): string {
  withoutOptions("shortenRevision", options)
  return call("gitlens/shorten-revision", { rev })
}
export function isRevisionRange(rev: string | undefined, ...options: unknown[]): boolean {
  withoutOptions("isRevisionRange", options)
  return call("gitlens/is-revision-range", { rev })
}
export function getFileDiffPathspecs(file: { path: string; originalPath?: string }): string[] {
  return call("gitlens/file-diff-pathspecs", { path: file.path, originalPath: file.originalPath ?? null })
}
// domain/path 取 Rust `remote::parse`（左栏分组与托管平台识别）；scheme 取 Desktop `parseRemote` 的 protocol
// （Desktop app/src/lib/remote-parsing.ts 的 IGitRemoteURL.protocol，GitCub 一比一保留在
// src/upstream/lib/remote-parsing.ts，克隆对话框据此请求克隆地址），只把 'https' / 'ssh' 写成 'https://' / 'ssh://'。
// Desktop 把 `git@host:` 与 `git:` 简写记为 ssh、`http://` 记为 https，GitLens 对前者给 undefined、后者给 'http://'。
export function parseGitRemoteUrl(url: string): [string | undefined, string | undefined, string | undefined] {
  const remote = call("remote/parse", { url })
  const protocol = desktopParseRemote(url)?.protocol
  const scheme = protocol === undefined ? undefined : `${protocol}://`
  return remote === null ? [scheme, undefined, undefined] : [scheme, remote.host, `${remote.owner}/${remote.name}`]
}
export function splitRemoteBranchName(name: string, remotes: Iterable<string>): [string, string] | undefined {
  return call("gitlens/split-remote-branch-name", { name, remotes: [...remotes] }) ?? undefined
}
