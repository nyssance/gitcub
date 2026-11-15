// 自有回归：「没有本地改动」空白页的建议顺序，对照 Desktop changes/no-changes.tsx:389-437
// renderRemoteAction、439-486 renderViewStashAction 与 796-812 renderActions。
import assert from "node:assert/strict"
import { it } from "node:test"

import {
  desktopStashForBranch,
  type NoChangesRepositoryState,
  primarySuggestion,
  remoteSuggestion
} from "../../src/lib/no-changes-suggestions"

const published: NoChangesRepositoryState = {
  branch: "feature",
  remote: "origin",
  aheadBehind: { ahead: 0, behind: 0 },
  tagsToPush: null,
  isForcePush: false,
  defaultBranch: "main",
  hasCurrentPullRequest: false,
  isHosted: true,
  stashEntry: null
}

it("follows Desktop renderRemoteAction in order", () => {
  assert.equal(remoteSuggestion({ ...published, branch: null }), null)
  assert.equal(remoteSuggestion({ ...published, remote: null }), "publish-repository")
  assert.equal(remoteSuggestion({ ...published, aheadBehind: null }), "publish-branch")
  assert.equal(remoteSuggestion({ ...published, isForcePush: true, aheadBehind: { ahead: 2, behind: 1 } }), null)
  assert.equal(remoteSuggestion({ ...published, aheadBehind: { ahead: 3, behind: 1 } }), "pull")
  assert.equal(remoteSuggestion({ ...published, aheadBehind: { ahead: 3, behind: 0 } }), "push")
  assert.equal(remoteSuggestion({ ...published, tagsToPush: ["v1"] }), "push")
  assert.equal(remoteSuggestion(published), "create-pull-request")
  assert.equal(remoteSuggestion({ ...published, hasCurrentPullRequest: true }), null)
  assert.equal(remoteSuggestion({ ...published, branch: "main" }), null)
  assert.equal(remoteSuggestion({ ...published, isHosted: false }), null)
})

it("prefers the stash of the current branch over the remote action", () => {
  const stash = { name: "stash@{0}", sha: "c".repeat(40), message: "!!GitHub_Desktop<feature>", ours: true }
  assert.equal(primarySuggestion({ ...published, stashEntry: stash }), "view-stash")
  assert.equal(primarySuggestion({ ...published, stashEntry: stash, branch: null }), null)
  assert.equal(primarySuggestion({ ...published, aheadBehind: { ahead: 1, behind: 0 } }), "push")
})

it("only a Desktop-created stash for the current branch counts", () => {
  const stashes = [
    { name: "stash@{0}", sha: "a".repeat(40), message: "WIP on feature: 1234567 work", ours: false },
    { name: "stash@{1}", sha: "b".repeat(40), message: "!!GitHub_Desktop<main>", ours: true },
    { name: "stash@{2}", sha: "c".repeat(40), message: "!!GitHub_Desktop<feature>", ours: true }
  ]
  assert.equal(desktopStashForBranch(stashes, "feature")?.name, "stash@{2}")
  assert.equal(desktopStashForBranch(stashes, "release"), null)
  assert.equal(desktopStashForBranch(stashes, null), null)
})
