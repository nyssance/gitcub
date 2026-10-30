// 自有回归：提交摘要的 +N −M。Desktop log.ts:284-341 parseRawLogWithNumstat 逐文件累加 numstat，
// `-`（二进制）按 0 计；expandable-commit-summary.tsx:541-567 renderLinesChanged 在两数都是 0 或
// 多选提交时不显示。
import assert from "node:assert/strict"
import { it } from "node:test"

import { changesetLineCounts, showsLineCounts } from "../../src/lib/commit-line-counts"
import type { CommitFile } from "../../src/models/history"

const file = (path: string, linesAdded: number | null, linesDeleted: number | null): CommitFile => ({
  path,
  kind: "modified",
  oldPath: null,
  renameIncludesModifications: false,
  submodule: false,
  linesAdded,
  linesDeleted
})

it("sums the numstat of every file and counts binary files as 0", () => {
  const counts = changesetLineCounts([file("a.txt", 3, 1), file("image.png", null, null), file("b.txt", 0, 4)])
  assert.deepEqual(counts, { linesAdded: 3, linesDeleted: 5 })
})

it("is empty for an empty changeset", () => {
  assert.deepEqual(changesetLineCounts([]), { linesAdded: 0, linesDeleted: 0 })
})

it("hides the counts when both are zero or several commits are selected", () => {
  assert.equal(showsLineCounts({ linesAdded: 0, linesDeleted: 0 }), false)
  assert.equal(showsLineCounts({ linesAdded: 1, linesDeleted: 0 }), true)
  assert.equal(showsLineCounts({ linesAdded: 0, linesDeleted: 2 }), true)
  assert.equal(showsLineCounts({ linesAdded: 5, linesDeleted: 2 }, 2), false)
})
