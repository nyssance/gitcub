// 测试环境适配。Git CLI 只用于上游测试要求的夹具准备/独立断言，不实现被测函数。
import { spawnSync } from "node:child_process"
import { access, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { TestContext } from "node:test"

export class Repository {
  path: string
  gitDir?: string
  mainWorktreePath?: string
  constructor(path: string, ...args: unknown[]) {
    this.path = path
    this.gitDir = args[6] as string | undefined
    this.mainWorktreePath = args[7] as string | undefined
  }
}

export async function createTempDirectory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "gitcub-desktop-fixture-"))
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return path
}

export async function setupEmptyRepository(t: TestContext, branch = "master") {
  // 与 Desktop helpers/repositories.ts 的空仓库目录、HEAD、config 一致。
  const path = await createTempDirectory(t)
  for (const entry of ["objects", "refs/tags", "refs/heads", "info"]) {
    await mkdir(join(path, ".git", entry), { recursive: true })
  }
  await writeFile(join(path, ".git/HEAD"), `ref: refs/heads/${branch}\n`)
  await writeFile(
    join(path, ".git/config"),
    `[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = false\nlogallrefupdates = true\nignorecase = ${process.platform === "linux" ? "true" : "false"}\nprecomposeunicode = true\n`
  )
  await writeFile(
    join(path, ".git/description"),
    "Unnamed repository; edit this file 'description' to name the repository.\n"
  )
  return new Repository(path)
}

export async function exec(args: string[], cwd: string, options?: { stdin?: string }) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000, input: options?.stdin })
  if (result.error) throw result.error
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status }
}
// Desktop helpers/assisted-commit.ts 里与 Copilot 无关的通用夹具：rawGit、tip、seed。
export async function rawGit(repository: Repository, args: string[]) {
  const result = await exec(args, repository.path)
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.replace(/\r?\n$/, "")
}
export async function tip(repository: Repository) {
  const sha = await rawGit(repository, ["rev-parse", "--verify", "HEAD"])
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new Error(`Unexpected HEAD: ${sha}`)
  return sha
}
export async function seed(t: TestContext, entries: Readonly<Record<string, string | Buffer>>) {
  const repository = await setupEmptyRepository(t)
  for (const [path, bytes] of Object.entries(entries)) {
    await mkdir(dirname(join(repository.path, path)), { recursive: true })
    await writeFile(join(repository.path, path), bytes)
  }
  await rawGit(repository, ["add", "--", ...Object.keys(entries)])
  await rawGit(repository, ["commit", "-m", "Initial commit"])
  return repository
}
export async function setupLocalConfig(repo: Repository, entries: [string, string][]) {
  for (const [key, value] of entries) {
    const result = await exec(["config", key, value], repo.path)
    if (result.exitCode !== 0) throw new Error(result.stderr)
  }
}
export async function pathExists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function git(args: string[], path: string, _name?: string, options?: { successExitCodes?: Set<number> }) {
  const result = await exec(args, path)
  if (result.exitCode !== 0 && !options?.successExitCodes?.has(result.exitCode!))
    throw new Error(result.stderr || result.stdout)
  return result
}
export async function setConfigValue(repo: Repository, key: string, value: string) {
  await git(["config", key, value], repo.path)
}
export async function getConfigValue(repo: Repository, key: string) {
  const result = await exec(["config", "--get", key], repo.path)
  if (result.exitCode === 1) return null
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.replace(/\n$/, "")
}
export async function setupEmptyDirectory(t: TestContext) {
  return new Repository(await createTempDirectory(t))
}
export async function isolateGitConfig(t: TestContext) {
  const config = join(await createTempDirectory(t), "empty-config")
  await writeFile(config, "")
  const environment = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_NOSYSTEM: "1" }
  const previous = Object.keys(environment).map(name => ({ name, value: process.env[name] }))
  t.after(() => {
    for (const { name, value } of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  Object.assign(process.env, environment)
}

export async function setupFixtureRepository(t: TestContext, name: string) {
  const root = process.env.GITCUB_FIXTURES_ROOT
  if (!root) throw new Error("Missing GITCUB_FIXTURES_ROOT")
  const path = await createTempDirectory(t)
  await cp(join(root, name), path, { recursive: true })
  async function restore(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name)
      const target = join(directory, entry.name === "_git" ? ".git" : entry.name)
      if (source !== target) await rename(source, target)
      if (entry.isDirectory()) await restore(target)
    }
  }
  await restore(path)
  return path
}
export async function getDefaultBranch() {
  return "main"
}

export async function setupOwnershipCheck(t: TestContext) {
  await isolateGitConfig(t)
  const config = process.env.GIT_CONFIG_GLOBAL!
  await writeFile(config, "[safe]\n\tdirectory =\n")
  const previous = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
    else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = previous
  })
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1"
  return config
}
export async function makeCommit(
  repo: Repository,
  tree: { entries: { path: string; contents: string | null }[]; commitMessage?: string }
) {
  for (const entry of tree.entries) {
    if (entry.contents === null) await git(["rm", entry.path], repo.path)
    else {
      await writeFile(join(repo.path, entry.path), entry.contents)
      await git(["add", entry.path], repo.path)
    }
  }
  await git(["commit", "-m", tree.commitMessage || "commit"], repo.path)
}

export const setupEmptyRepositoryDefaultMain = (t: TestContext) => setupEmptyRepository(t, "main")
export async function getTempFilePath(prefix: string) {
  return join(await mkdtemp(join(tmpdir(), "gitcub-message-")), prefix)
}

// Desktop helpers/repositories.ts (db99902e7): pathspec-magic fixtures, bodies unchanged.
export const PathspecMagicFileName = ":(glob)*.txt"

/** Set up a repository with a tracked file whose name uses pathspec syntax. */
export async function setupRepositoryWithPathspecMagicFile(t: TestContext): Promise<Repository> {
  const repo = await setupEmptyRepository(t)

  await writeFile(join(repo.path, PathspecMagicFileName), "base content\n")
  await writeFile(join(repo.path, "unrelated.txt"), "unrelated content\n")
  await exec(["add", "--all"], repo.path)
  await exec(["commit", "-m", "Initial commit"], repo.path)

  return repo
}

/** Set up a repository with a conflict in a pathspec-magic filename. */
export async function setupConflictedRepoWithPathspecMagicFile(
  t: TestContext,
  includeUnrelatedConflict = false
): Promise<Repository> {
  const repo = await setupRepositoryWithPathspecMagicFile(t)

  await exec(["branch", "other-branch"], repo.path)

  await writeFile(join(repo.path, PathspecMagicFileName), "master content\n")
  if (includeUnrelatedConflict) {
    await writeFile(join(repo.path, "unrelated.txt"), "master unrelated\n")
  }
  await exec(["add", "--all"], repo.path)
  await exec(["commit", "-m", "Update on master"], repo.path)

  await switchTo(repo, "other-branch")
  await writeFile(join(repo.path, PathspecMagicFileName), "other content\n")
  if (includeUnrelatedConflict) {
    await writeFile(join(repo.path, "unrelated.txt"), "other unrelated\n")
  }
  await exec(["add", "--all"], repo.path)
  await exec(["commit", "-m", "Update on other branch"], repo.path)

  await exec(["merge", "master"], repo.path)

  return repo
}

export async function setupConflictedRepo(t: TestContext): Promise<Repository> {
  const repo = await setupEmptyRepository(t)

  const firstCommit = {
    entries: [{ path: "foo", contents: "" }]
  }

  await makeCommit(repo, firstCommit)

  // create this branch starting from the first commit, but don't checkout it
  // because we want to create a divergent history
  await exec(["branch", "other-branch"], repo.path)

  const secondCommit = {
    entries: [{ path: "foo", contents: "b1" }]
  }

  await makeCommit(repo, secondCommit)

  await switchTo(repo, "other-branch")

  const thirdCommit = {
    entries: [{ path: "foo", contents: "b2" }]
  }
  await makeCommit(repo, thirdCommit)

  await exec(["merge", "master"], repo.path)

  return repo
}

export async function setupConflictedRepoWithMultipleFiles(t: TestContext): Promise<Repository> {
  const repo = await setupEmptyRepository(t)

  const firstCommit = {
    entries: [
      { path: "foo", contents: "b0" },
      { path: "bar", contents: "b0" }
    ]
  }

  await makeCommit(repo, firstCommit)

  // create this branch starting from the first commit, but don't checkout it
  // because we want to create a divergent history
  await exec(["branch", "other-branch"], repo.path)

  const secondCommit = {
    entries: [
      { path: "foo", contents: "b1" },
      { path: "bar", contents: null },
      { path: "baz", contents: "b1" },
      { path: "cat", contents: "b1" }
    ]
  }

  await makeCommit(repo, secondCommit)

  await switchTo(repo, "other-branch")

  const thirdCommit = {
    entries: [
      { path: "foo", contents: "b2" },
      { path: "bar", contents: "b2" },
      { path: "baz", contents: "b2" },
      { path: "cat", contents: "b2" }
    ]
  }

  await makeCommit(repo, thirdCommit)

  await writeFile(join(repo.path, "dog"), "touch")

  await exec(["merge", "master"], repo.path)

  return repo
}

export async function setupTwoCommitRepo(t: TestContext): Promise<Repository> {
  const repo = await setupEmptyRepository(t)

  const firstCommit = {
    entries: [
      { path: "good-file", contents: "wishes it was great" },
      { path: "great-file", contents: "wishes it was good" }
    ]
  }
  const secondCommit = {
    entries: [
      { path: "good-file", contents: "is great" },
      { path: "great-file", contents: "is good" }
    ]
  }

  await makeCommit(repo, firstCommit)
  await makeCommit(repo, secondCommit)
  return repo
}

export async function setupLocalForkOfRepository(t: TestContext, upstream: Repository): Promise<Repository> {
  const path = await createTempDirectory(t)
  await git(["clone", "--local", upstream.path, path], path, "clone")
  return new Repository(path, -1, null, false)
}

export async function setupRepositoryWithUninitializedSubmodule(t: TestContext): Promise<Repository> {
  const repo = await setupTwoCommitRepo(t)

  // Create a submodule repository
  const submoduleRepo = await setupTwoCommitRepo(t)

  // Create a new branch and add the submodule
  await exec(["checkout", "-b", "branch-with-submodule"], repo.path)

  await exec(["-c", "protocol.file.allow=always", "submodule", "add", submoduleRepo.path, "test-submodule"], repo.path)
  await exec(["commit", "-m", "Add submodule"], repo.path)

  // Go back to main branch
  await exec(["checkout", "master"], repo.path)

  // Remove the .git/modules directory for the submodule to make it uninitialized
  const modulesPath = join(repo.path, ".git", "modules", "test-submodule")
  await rm(modulesPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  await rm(join(repo.path, "test-submodule"), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })

  return repo
}

export async function switchTo(repo: Repository, branch: string) {
  const result = await exec(["rev-parse", "--verify", branch], repo.path)
  await git(result.exitCode === 128 ? ["checkout", "-b", branch] : ["checkout", branch], repo.path)
}

export const cloneLocalRepository = setupLocalForkOfRepository

export async function createRepository(t: TestContext, branchName: string): Promise<Repository> {
  const repository = await setupEmptyRepository(t)

  // make two commits on `master` to setup the README

  const firstCommit = {
    commitMessage: "First!",
    entries: [
      {
        path: "README.md",
        contents: "# HELLO WORLD! \n"
      }
    ]
  }

  await makeCommit(repository, firstCommit)

  const secondCommit = {
    commitMessage: "Second!",
    entries: [
      {
        path: "THING.md",
        contents: "# HELLO WORLD! \nTHINGS GO HERE\n"
      },
      {
        path: "OTHER.md",
        contents: "# HELLO WORLD! \nTHINGS GO HERE\n"
      }
    ]
  }

  await makeCommit(repository, secondCommit)

  await switchTo(repository, branchName)

  const firstCommitToBranch = {
    commitMessage: "Added a new file",
    entries: [
      {
        path: "CONTRIBUTING.md",
        contents: ""
      }
    ]
  }

  await makeCommit(repository, firstCommitToBranch)

  const secondCommitToBranch = {
    commitMessage: "Updated README",
    entries: [
      {
        path: "README.md",
        contents: "things go here"
      }
    ]
  }

  await makeCommit(repository, secondCommitToBranch)

  return repository
}

export async function cloneRepository(t: TestContext, repository: Repository) {
  const directory = await createTempDirectory(t)
  await git(["clone", repository.path, "--", directory], tmpdir())
  return new Repository(directory, -2, null, false)
}

export const GitError = Object.fromEntries(
  [
    "MergeConflicts",
    "BadRevision",
    "ConfigLockFileAlreadyExists",
    "MergeWithLocalChanges",
    "RebaseWithLocalChanges",
    "LocalChangesOverwritten",
    "SSHKeyAuditUnverified"
  ].map(key => [key, key])
)

export async function createBranch(repository: Repository, branch: string, startPoint: string) {
  const result = await exec(["rev-parse", "--verify", branch], repository.path)
  if (result.exitCode !== 128) throw new Error(`Branch ${branch} already exists`)
  await git(["branch", branch, startPoint], repository.path)
}

export function getFixturePath(name: string): string {
  return join(process.env.GITCUB_FIXTURES_ROOT!, name)
}
