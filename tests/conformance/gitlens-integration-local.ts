import { call } from "./bridge"

// GitLens c1f6e5f3c integration 套件（commits.searchTypeMerge、revision、revParseGitDir、env.gitDir、
// gitIgnoreFilter）的最小适配：原版 helpers.ts 快照照常用 git CLI 准备仓库，它与这些套件导入的
// CliGitProvider / Git / locator 换成这里的同名入口。每个方法只经 Rust JSON 桥调用 GitCub 生产函数，
// 把结果放进套件读取的那几个 GitLens 字段，不计算预期值；套件没用到的入口一律报错。

type Context = unknown
type ProviderOptions = { context: Context; locator: unknown; gitOptions?: unknown }
type NativeCommit = { sha: string }
type NativeStash = { sha: string }
type NativeTip =
  | { kind: "Valid"; branch: { name: string } }
  | { kind: "Unborn"; ref: string }
  | { kind: "Detached"; currentSha: string }
type NativeRepositoryType =
  | { kind: "missing" | "bare" }
  | { kind: "unsafe"; path: string }
  | { kind: "regular"; gitDir: string; topLevelWorkingDirectory: string }

export class CliGitProvider {
  readonly context: Context
  constructor(options: ProviderOptions) {
    this.context = options.context
  }

  // history::search；原版测试配置没有 search.maxItems，limit 为 0 即不限条数。
  readonly commits = {
    searchCommits: async (repoPath: string, search: object) => {
      const commits: NativeCommit[] = call("search", { repo: repoPath, search, limit: 0, skip: 0 })
      return { log: { commits: new Map(commits.map(commit => [commit.sha, commit])) } }
    }
  }

  // ops::stashes
  readonly stash = {
    getStash: async (repoPath: string, _options?: { includeFiles?: boolean }) => {
      const stashes: NativeStash[] = call("stash/list", { repo: repoPath })
      return { stashes: new Map(stashes.map(stash => [stash.sha, stash])) }
    }
  }

  // history::resolve_shas
  readonly revision = {
    resolveShas: async (repoPath: string, shas: Set<string>) =>
      new Set<string>(call("gitlens/resolve-shas", { repo: repoPath, shas: [...shas] }))
  }

  // branch::tip：当前分支名；分离 HEAD 的 GitBranch 形状没有移植。
  readonly branches = {
    getBranch: async (repoPath: string) => {
      const tip: NativeTip = call("branch/tip", { repo: repoPath })
      if (tip.kind === "Valid") return { name: tip.branch.name }
      if (tip.kind === "Unborn") return { name: tip.ref }
      throw new Error("getBranch: detached HEAD is not ported")
    }
  }

  // watch::ignored_by_git（文件监听过滤用的 gix 判定），每次判定同步调用桥。
  getIgnoreFilter(repoPath: string) {
    return {
      ready: async () => {},
      isIgnored: (path: string): boolean => call("gitlens/ignored", { repo: repoPath, path })
    }
  }

  dispose() {}
}

export class GitError extends Error {}

// repository::repository_type（Desktop getRepositoryType 的移植）：missing → undefined，regular → gitDir，
// 所有权异常与桥报错 → GitError。
export class Git {
  constructor(_locator: unknown) {}
  async rev_parse__git_dir(cwd: string): Promise<{ path: string; commonPath?: string } | undefined> {
    let type: NativeRepositoryType
    try {
      type = call("repository/type", { repo: cwd })
    } catch (error) {
      throw new GitError(String(error))
    }
    switch (type.kind) {
      case "missing":
        return undefined
      case "regular":
        return { path: type.gitDir }
      case "unsafe":
        throw new GitError(`detected dubious ownership in repository at '${type.path}'`)
      default:
        throw new Error("rev_parse__git_dir: bare repositories are not ported")
    }
  }
}

// 套件与 helpers.ts 只把定位结果交给上面的构造函数；Rust 侧自己找 git。
export async function findGitPath(_paths: unknown) {
  return { path: "git", version: "" }
}

export const Logger = { configure(_options: unknown) {} }

export function createCliGitService(): never {
  throw new Error("createCliGitService is not used by the locally ported GitLens suites")
}
export function verifyBaseRemeasure(): never {
  throw new Error("verifyBaseRemeasure is not used by the locally ported GitLens suites")
}
