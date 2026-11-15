// 自有回归：「我的」页签为空时，账号验证失败（断网、令牌被拒）不能显示成未登录（AGENTS.md：读取失败不能冒充未登录）。
import { expect, test } from "bun:test"

import { accountEmptyState } from "../../src/lib/account-state"

const account = (overrides: Partial<Parameters<typeof accountEmptyState>[0][string]> = {}) => ({
  kind: null,
  login: null,
  owners: [],
  source: null,
  ignored: false,
  ...overrides
})

test("没有任何账号就是未登录", () => {
  expect(accountEmptyState({ "github.com": account(), "gitlab.com": account() })).toEqual({ kind: "signedOut" })
})

test("验证失败且没有上次成功结果时报失败原因，不冒充未登录", () => {
  expect(
    accountEmptyState({
      "github.com": account(),
      "git.example": account({ error: "请求失败: error sending request" })
    })
  ).toEqual({ kind: "failed", host: "git.example", error: "请求失败: error sending request" })
})

test("令牌被拒但缓存里还有登录名时仍算已登录，由顶部提示说明失效", () => {
  expect(
    accountEmptyState({
      "git.example": account({ login: "me", kind: "gitlab", error: "HTTP 401：401 Unauthorized", unauthorized: true })
    })
  ).toEqual({ kind: "signedIn" })
})

test("显式登出的实例不算失败", () => {
  expect(accountEmptyState({ "git.example": account({ ignored: true, error: "HTTP 401" }) })).toEqual({
    kind: "signedOut"
  })
})
