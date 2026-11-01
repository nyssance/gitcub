// 自有回归：推拉按钮移植（2026-11-01）。Desktop 没有对应单元测试，这里锁住
// rebase.ts getCurrentBranchForcePushState、git-store updateLastFetched 与 _addBranchToForcePushList 的语义。
import { beforeEach, expect, test } from "bun:test"

import { useAppStateStore } from "../../src/features/app-state/store"
import { EMPTY_STATUS, nextLastFetched, useRepositoryStore } from "../../src/features/repository/store"
import { ForcePushBranchState, getCurrentBranchForcePushState } from "../../src/lib/force-push-state"

const diverged = { branch: "main", head: "b", hasUpstream: true, ahead: 1, behind: 1 }

test("没有上游或没分叉时不能强推；分叉时可强推，本应用改写过且还在原处才建议", () => {
  expect(getCurrentBranchForcePushState({ ...diverged, hasUpstream: false }, { main: "b" })).toBe(
    ForcePushBranchState.NotAvailable
  )
  expect(getCurrentBranchForcePushState({ ...diverged, behind: 0 }, { main: "b" })).toBe(
    ForcePushBranchState.NotAvailable
  )
  expect(getCurrentBranchForcePushState({ ...diverged, ahead: 0 }, { main: "b" })).toBe(
    ForcePushBranchState.NotAvailable
  )
  expect(getCurrentBranchForcePushState(diverged, undefined)).toBe(ForcePushBranchState.Available)
  expect(getCurrentBranchForcePushState(diverged, { main: "a" })).toBe(ForcePushBranchState.Available)
  expect(getCurrentBranchForcePushState(diverged, { main: "b" })).toBe(ForcePushBranchState.Recommended)
  expect(getCurrentBranchForcePushState({ ...diverged, branch: null }, { main: "b" })).toBe(
    ForcePushBranchState.Available
  )
})

test("上次拉取：没有 FETCH_HEAD 是从没拉取过，空文件沿用上一次", () => {
  const previous = new Date(1000)
  expect(nextLastFetched(null, previous)).toBeNull()
  expect(nextLastFetched({ modifiedMs: 1000, empty: true }, previous)).toBe(previous)
  expect(nextLastFetched({ modifiedMs: 2000, empty: false }, previous)?.getTime()).toBe(2000)
})

beforeEach(() => {
  useAppStateStore.setState({ state: { selectedRepository: "/r" } as never })
  useRepositoryStore.setState({ forcePushBranches: {}, pendingRewrites: {}, status: EMPTY_STATUS })
})

test("改写后 HEAD 变了才记进 forcePushBranches，按仓库分开", () => {
  const store = useRepositoryStore.getState()
  useRepositoryStore.setState({ status: { ...EMPTY_STATUS, branch: "main", head: "a" } })
  store.settleRewrite("/r", "a")
  expect(useRepositoryStore.getState().forcePushBranches).toEqual({})
  useRepositoryStore.setState({ status: { ...EMPTY_STATUS, branch: "main", head: "b" } })
  store.settleRewrite("/r", "a")
  expect(useRepositoryStore.getState().forcePushBranches).toEqual({ "/r": { main: "b" } })
  // 不是当前仓库的结果不记
  store.settleRewrite("/other", "a")
  expect(Object.keys(useRepositoryStore.getState().forcePushBranches)).toEqual(["/r"])
})

test("变基停在冲突上先挂起，继续做完才记；中止就丢掉", () => {
  const store = useRepositoryStore.getState()
  useRepositoryStore.setState({ status: { ...EMPTY_STATUS, branch: "main", head: "a", operation: "rebase" } })
  store.settleRewrite("/r", "a")
  expect(useRepositoryStore.getState().pendingRewrites).toEqual({ "/r": "a" })
  expect(useRepositoryStore.getState().forcePushBranches).toEqual({})
  // 还卡在下一处冲突
  store.settleRewrite("/r")
  expect(useRepositoryStore.getState().pendingRewrites).toEqual({ "/r": "a" })
  useRepositoryStore.setState({ status: { ...EMPTY_STATUS, branch: "main", head: "c" } })
  store.settleRewrite("/r")
  expect(useRepositoryStore.getState().pendingRewrites).toEqual({})
  expect(useRepositoryStore.getState().forcePushBranches).toEqual({ "/r": { main: "c" } })

  useRepositoryStore.setState({ status: { ...EMPTY_STATUS, branch: "main", head: "c", operation: "rebase" } })
  store.settleRewrite("/r", "c")
  store.dropRewrite("/r")
  useRepositoryStore.setState({ status: { ...EMPTY_STATUS, branch: "main", head: "c" } })
  store.settleRewrite("/r")
  expect(useRepositoryStore.getState().forcePushBranches).toEqual({ "/r": { main: "c" } })
})

test("没有挂起的变基时，继续合并或拣选不记强推", () => {
  useRepositoryStore.setState({ status: { ...EMPTY_STATUS, branch: "main", head: "z" } })
  useRepositoryStore.getState().settleRewrite("/r")
  expect(useRepositoryStore.getState().forcePushBranches).toEqual({})
})
