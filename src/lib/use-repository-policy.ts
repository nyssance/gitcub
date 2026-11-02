import { invoke } from "@tauri-apps/api/core"
import { useEffect, useMemo, useState } from "react"

import type { Account } from "../models/account"
import type { Remote } from "../models/app-state"
import { GitHubRepository } from "../models/github-repository"
import { Owner } from "../models/owner"
import { Repository } from "../models/repository"
import { RepoRulesInfo } from "../upstream/models/repo-rules"
import { getHTMLURL } from "./api"
import type { IAPIRepoRule, IAPIRepoRuleset } from "./api-rule-types"
import { parseRepoRules } from "./repo-rules"

interface BranchPolicy {
  remote: Remote
  kind: "github" | "gitlab"
  metadata: {
    private?: boolean
    html_url?: string
    clone_url?: string
    has_issues?: boolean
    archived?: boolean
    default_branch?: string
  }
  protected: boolean
  noWrite: boolean
  rules: IAPIRepoRule[]
  rulesets: IAPIRepoRuleset[]
}
export interface RepositoryPolicy {
  repository: Repository
  rules: RepoRulesInfo
  protected: boolean
  noWrite: boolean
  rulesets: Map<number, IAPIRepoRuleset>
  account: Account | null
  forkUrl: string | null
}

export function emptyRepositoryPolicy(path: string): RepositoryPolicy {
  return {
    repository: new Repository(path, -1, null, false),
    rules: new RepoRulesInfo(),
    protected: false,
    noWrite: false,
    rulesets: new Map(),
    account: null,
    forkUrl: null
  }
}

/** 分支策略取不到时（远端连不上、账号验证失败、规则接口出错）与 Desktop 一样保持安静：
 *  refreshBranchProtectionState 没有账号就直接返回（app-store.ts 1497-1500），fetchPushControl、
 *  fetchRepoRulesForBranch、fetchRepoRuleset 失败只 log.info 并按不受保护、没有规则处理
 *  （api.ts 1654-1687、1716-1739、1773-1787），提交框从不显示这类错误。 */
export async function loadRepositoryPolicy(
  path: string,
  branch: string,
  accounts: readonly Account[],
  io: {
    branchPolicy: (repo: string, branch: string) => Promise<BranchPolicy | null>
  } = {
    branchPolicy: (repo, branch) => invoke<BranchPolicy | null>("branch_policy", { repo, branch })
  }
): Promise<RepositoryPolicy | null> {
  let value: BranchPolicy | null
  try {
    value = await io.branchPolicy(path, branch)
  } catch (error) {
    log.info(`[loadRepositoryPolicy] unable to read the branch policy for ${branch}`, error)
    return null
  }
  if (!value) return null
  {
    const account = accounts.find(account => new URL(getHTMLURL(account.endpoint)).host === value.remote.host) ?? null
    const { remote, metadata } = value
    const endpoint = remote.host === "github.com" ? "https://api.github.com" : `https://${remote.host}/api/v3`
    const github =
      value.kind === "github"
        ? new GitHubRepository(
            remote.name,
            new Owner(remote.owner, endpoint, -1),
            -1,
            metadata.private ?? null,
            metadata.html_url ?? null,
            metadata.clone_url ?? null,
            metadata.has_issues ?? null,
            metadata.archived ?? null,
            value.noWrite ? "read" : "write"
          )
        : null
    const repository = new Repository(path, -1, github, false)
    const rulesets = new Map(value.rulesets.map(ruleset => [ruleset.id, ruleset]))
    const rules = await parseRepoRules(value.rules, rulesets, repository)
    return {
      repository,
      account,
      rules,
      rulesets,
      protected: value.protected,
      noWrite: value.noWrite,
      forkUrl: `https://${remote.host}/${remote.owner}/${remote.name}${value.kind === "gitlab" ? "/-/forks/new" : "/fork"}`
    }
  }
}

export function useRepositoryPolicy(path: string, branch: string | null, accounts: readonly Account[]) {
  const empty = useMemo(() => emptyRepositoryPolicy(path), [path])
  const [policy, setPolicy] = useState(empty)
  useEffect(() => {
    let active = true
    setPolicy(empty)
    if (!branch || !path) return
    loadRepositoryPolicy(path, branch, accounts).then(
      value => {
        if (active && value) setPolicy(value)
      },
      (error: unknown) => log.error(`[useRepositoryPolicy] unable to build the policy for ${branch}`, error)
    )
    return () => {
      active = false
    }
  }, [path, branch, accounts, empty])
  return policy
}
