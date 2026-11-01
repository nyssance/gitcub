// 自有回归：远端连不上、账号验证失败或规则接口出错时，提交框不显示「分支策略查询失败」。
// Desktop refreshBranchProtectionState（app-store.ts 1492-1577）没有账号就返回，fetchPushControl /
// fetchRepoRulesForBranch / fetchRepoRuleset 失败只 log.info（api.ts 1654-1687、1716-1739、1773-1787）。
import assert from "node:assert/strict"
import { it } from "node:test"

import { emptyRepositoryPolicy, loadRepositoryPolicy } from "../../src/lib/use-repository-policy"

it("an unreachable remote host leaves the commit form without a policy error", async () => {
  const logged: unknown[][] = []
  const previous = log.info
  log.info = (...args: unknown[]) => void logged.push(args)
  try {
    const policy = await loadRepositoryPolicy("/repo", "main", [], {
      branchPolicy: () => Promise.reject(new Error("git.example 账号验证失败：请求失败: error sending request"))
    })
    assert.equal(policy, null)
    assert.equal(logged.length, 1)
    assert.match(String(logged[0][0]), /unable to read the branch policy for main/)
  } finally {
    log.info = previous
  }
})

it("a repository without a hosted remote keeps the empty policy", async () => {
  const policy = await loadRepositoryPolicy("/repo", "main", [], {
    branchPolicy: () => Promise.resolve(null)
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
      })
  })
  assert.ok(policy)
  assert.equal(policy.protected, false)
  assert.equal(policy.forkUrl, "https://github.com/me/repo/fork")
})
