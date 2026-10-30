// 自有回归：远端连不上、账号验证失败或规则接口出错时，提交框不显示「分支策略查询失败」。
// Desktop refreshBranchProtectionState（app-store.ts 1492-1577）没有账号就返回，fetchPushControl /
// fetchRepoRulesForBranch / fetchRepoRuleset 失败只 log.info（api.ts 1654-1687、1716-1739、1773-1787）。
import assert from "node:assert/strict"
import { it } from "node:test"

import { emptyRepositoryPolicy, loadRepositoryPolicy } from "../../src/lib/use-repository-policy"

const status = { hasUpstream: true, ahead: 0, behind: 0 }

it("an unreachable remote host leaves the commit form without a policy error", async () => {
  const logged: unknown[][] = []
  const previous = log.info
  log.info = (...args: unknown[]) => void logged.push(args)
  try {
    const policy = await loadRepositoryPolicy("/repo", "main", [], {
      branchPolicy: () => Promise.reject(new Error("git.example 账号验证失败：请求失败: error sending request")),
      repoStatus: () => Promise.resolve(status)
    })
    assert.equal(policy, null)
    assert.equal(logged.length, 1)
    assert.match(String(logged[0][0]), /unable to read the branch policy for main/)
  } finally {
    log.info = previous
  }
})

it("a failing local status is logged as an error and keeps the policy", async () => {
  const errors: unknown[][] = []
  const previous = log.error
  log.error = (...args: unknown[]) => void errors.push(args)
  try {
    const policy = await loadRepositoryPolicy("/repo", "main", [], {
      branchPolicy: () =>
        Promise.resolve({
          remote: { host: "github.com", owner: "me", name: "repo" } as never,
          kind: "github" as const,
          metadata: {},
          protected: true,
          noWrite: false,
          rules: [],
          rulesets: []
        }),
      repoStatus: () => Promise.reject(new Error("fatal: index file corrupt"))
    })
    assert.ok(policy)
    assert.equal(policy.protected, true)
    assert.equal(policy.aheadBehind, null)
    assert.equal(errors.length, 1)
    assert.match(String(errors[0][0]), /unable to read the local status for main/)
  } finally {
    log.error = previous
  }
})

it("a repository without a hosted remote keeps the empty policy", async () => {
  const policy = await loadRepositoryPolicy("/repo", "main", [], {
    branchPolicy: () => Promise.resolve(null),
    repoStatus: () => Promise.resolve(status)
  })
  assert.equal(policy, null)
  const empty = emptyRepositoryPolicy("/repo")
  assert.equal(empty.protected, false)
  assert.equal(empty.rules.basicCommitWarning, false)
})

it("a reachable host without rules reports the branch as unprotected", async () => {
  const policy = await loadRepositoryPolicy("/repo", "main", [], {
    branchPolicy: () =>
      Promise.resolve({
        remote: { host: "github.com", owner: "me", name: "repo" } as never,
        kind: "github" as const,
        metadata: {},
        protected: false,
        noWrite: false,
        rules: [],
        rulesets: []
      }),
    repoStatus: () => Promise.resolve({ hasUpstream: true, ahead: 2, behind: 1 })
  })
  assert.ok(policy)
  assert.equal(policy.protected, false)
  assert.deepEqual(policy.aheadBehind, { ahead: 2, behind: 1 })
  assert.equal(policy.forkUrl, "https://github.com/me/repo/fork")
})
