import type { CommitInfo } from "../src/models/history"
import type { FileChange, RepoStatus, RepoSummary } from "../src/models/repo-status"

export const repo = "/preview/gitcub"
export const commit: CommitInfo = {
  sha: "a".repeat(40),
  shortSha: "aaaaaaa",
  summary: "Fix issue #42",
  body: "Preserve gitlab/group paths.\nSee #123 and literal abc#5.",
  authorName: "GitCub Preview",
  authorEmail: "preview@example.test",
  time: 1767225600,
  parentCount: 1,
  parentSHAs: ["b".repeat(40)],
  tags: []
}
export const file: FileChange = {
  path: "src/main.tsx",
  kind: "unstaged",
  change: "modified",
  oldPath: null,
  conflict: null,
  submodule: null
}
export const status: RepoStatus = {
  branch: "main",
  changes: [],
  remote: "origin",
  hasUpstream: true,
  ahead: 0,
  behind: 0,
  operation: null,
  theirs: null
}
/** 待办页的摘要：只有引用和索引能回答的事，与 status.rs 的 RepoSummary 对应 */
export const summary: RepoSummary = {
  branch: "main",
  remote: "origin",
  hasUpstream: true,
  ahead: 0,
  behind: 0,
  conflicts: []
}
export const pending = () => new Promise<never>(() => {})
export const unavailable = () => {
  throw new Error("Preview service unavailable")
}
