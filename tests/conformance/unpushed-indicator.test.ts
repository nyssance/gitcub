// 自有回归：历史行的「未推送」标记。Desktop commit-list.tsx:270-290 renderCommit 用
// localCommitSHAs（git-store.ts:608-630 loadLocalCommits：有上游时是 upstream..branch，没有上游时是
// `HEAD --not --remotes`）且 isLocalRepository === false 才显示；这里有上游时用状态里的 ahead 数和
// HEAD 历史下标代替，没有上游时用 app.tsx 每次刷新取一次的 `--not --remotes` SHA 集合。
import assert from "node:assert/strict"
import { it } from "node:test"

import { isUnpushedCommit, type LocalCommits } from "../../src/lib/unpushed-commits"

const published = { remote: "origin", hasUpstream: true, ahead: 2 }
const unpublished = { remote: "origin", hasUpstream: false, ahead: 0 }
const local: LocalCommits = { shas: new Set(["aaa", "bbb"]), done: true }

it("marks the newest `ahead` commits of the HEAD history", () => {
  assert.equal(isUnpushedCommit("x", 0, published), true)
  assert.equal(isUnpushedCommit("x", 1, published), true)
  assert.equal(isUnpushedCommit("x", 2, published), false)
  assert.equal(isUnpushedCommit("x", 10, published), false)
})

it("marks nothing when everything is pushed", () => {
  assert.equal(isUnpushedCommit("x", 0, { ...published, ahead: 0 }), false)
})

it("marks nothing in a local-only repository (Desktop isLocalRepository)", () => {
  assert.equal(isUnpushedCommit("aaa", 0, { remote: null, hasUpstream: false, ahead: 0 }, local), false)
  assert.equal(isUnpushedCommit("aaa", 0, { remote: null, hasUpstream: true, ahead: 3 }, local), false)
})

it("marks nothing for commits outside the HEAD history or without status", () => {
  assert.equal(isUnpushedCommit("x", undefined, published), false)
  assert.equal(isUnpushedCommit("aaa", 0, null, local), false)
})

it("without an upstream, marks the commits of `HEAD --not --remotes` (Desktop git-store.ts:624-629)", () => {
  assert.equal(isUnpushedCommit("aaa", 0, unpublished, local), true)
  assert.equal(isUnpushedCommit("bbb", 1, unpublished, local), true)
  assert.equal(isUnpushedCommit("ccc", 2, unpublished, local), false)
  // Desktop 按 SHA 查 localCommitSHAs，与行在列表里的位置无关（搜索结果、文件历史同样能标）
  assert.equal(isUnpushedCommit("aaa", undefined, unpublished, local), true)
})

it("without an upstream, marks nothing until the set has been fetched and ignores `ahead`", () => {
  assert.equal(isUnpushedCommit("aaa", 0, unpublished), false)
  assert.equal(isUnpushedCommit("aaa", 0, unpublished, null), false)
  assert.equal(isUnpushedCommit("ccc", 0, { ...unpublished, ahead: 5 }, local), false)
  // 有上游时不看集合：上游存在就按 ahead 数
  assert.equal(isUnpushedCommit("ccc", 0, published, local), true)
  assert.equal(isUnpushedCommit("aaa", 5, published, local), false)
})
