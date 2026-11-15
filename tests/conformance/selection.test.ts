import assert from "node:assert/strict"
import { readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
// GitCub 自有端到端回归，不计入原版上游测试数。
import { describe, it } from "node:test"

import { getDiff } from "../../src/lib/diff"
import { applySelection, discardLines } from "../../src/lib/stage"
import { DiffSelection, DiffSelectionType } from "../../src/upstream/models/diff"
import { call } from "./bridge.ts"
import { git, setupEmptyRepository } from "./fixtures.ts"

describe("GitCub selection integration regressions", () => {
  it("partially stages an already staged new file", async t => {
    const repo = await setupEmptyRepository(t)
    await writeFile(join(repo.path, "new"), "line1\nline2\nline3\n")
    await git(["add", "new"], repo.path)
    const file = call("status", { repo: repo.path }).changes[0]
    assert.equal(file.change, "added")
    const selection = DiffSelection.fromInitialSelection(DiffSelectionType.None).withLineSelection(1, true)
    await applySelection(repo.path, [{ file, include: DiffSelectionType.Partial, selection }])
    assert.equal((await git(["show", ":new"], repo.path)).stdout, "line1\n")
  })
  it("partially stages a deletion", async t => {
    const repo = await setupEmptyRepository(t)
    await writeFile(join(repo.path, "file"), "line1\nline2\nline3\n")
    await git(["add", "."], repo.path)
    await git(["commit", "-m", "initial"], repo.path)
    await unlink(join(repo.path, "file"))
    const file = call("status", { repo: repo.path }).changes[0]
    const selection = DiffSelection.fromInitialSelection(DiffSelectionType.None).withLineSelection(1, true)
    await applySelection(repo.path, [{ file, include: DiffSelectionType.Partial, selection }])
    assert.equal((await git(["show", ":file"], repo.path)).stdout, "line2\nline3\n")
  })
  it("reconstructs a rename before applying selected added lines", async t => {
    const repo = await setupEmptyRepository(t)
    await writeFile(join(repo.path, "foo"), "line1\n")
    await git(["add", "."], repo.path)
    await git(["commit", "-m", "initial"], repo.path)
    await git(["mv", "foo", "bar"], repo.path)
    await writeFile(join(repo.path, "bar"), "line1\nline2\nline3\n")
    const file = call("status", { repo: repo.path }).changes[0]
    assert.equal(file.change, "renamed")
    const selection = DiffSelection.fromInitialSelection(DiffSelectionType.None).withLineSelection(2, true)
    await applySelection(repo.path, [{ file, include: DiffSelectionType.Partial, selection }])
    assert.equal((await git(["show", ":bar"], repo.path)).stdout, "line1\nline2\n")
    assert.equal((await git(["ls-files", "foo"], repo.path)).stdout, "")
  })
  it("refuses stale partial selections before changing the index", async t => {
    const repo = await setupEmptyRepository(t)
    await writeFile(join(repo.path, "file"), "one\ntwo\n")
    await git(["add", "."], repo.path)
    await git(["commit", "-m", "base"], repo.path)
    await writeFile(join(repo.path, "file"), "one\nselected\n")
    const expectedDiff = (await getDiff(repo.path, "file", "normal")).diff
    const file = call("status", { repo: repo.path }).changes[0]
    const selection = DiffSelection.fromInitialSelection(DiffSelectionType.None).withLineSelection(3, true)
    await writeFile(join(repo.path, "file"), "one\ndifferent\n")
    const before = (await git(["write-tree"], repo.path)).stdout
    await assert.rejects(
      applySelection(repo.path, [{ file, include: DiffSelectionType.Partial, selection, expectedDiff }]),
      /file changed/
    )
    assert.equal((await git(["write-tree"], repo.path)).stdout, before)
    assert.equal(await readFile(join(repo.path, "file"), "utf8"), "one\ndifferent\n")
  })
  it("discards only one contiguous group and preserves the other edit and index", async t => {
    const repo = await setupEmptyRepository(t)
    await writeFile(join(repo.path, "file"), "a\nold1\ncontext\nold2\nz\n")
    await git(["add", "."], repo.path)
    await git(["commit", "-m", "base"], repo.path)
    await writeFile(join(repo.path, "file"), "a\nnew1\ncontext\nnew2\nz\n")
    const raw = (await getDiff(repo.path, "file", "normal")).diff
    const before = (await git(["write-tree"], repo.path)).stdout
    await discardLines(repo.path, "file", raw, [2, 3])
    assert.equal(await readFile(join(repo.path, "file"), "utf8"), "a\nold1\ncontext\nnew2\nz\n")
    assert.equal((await git(["write-tree"], repo.path)).stdout, before)
    await assert.rejects(discardLines(repo.path, "file", raw, [5, 6]), /file changed/)
    assert.equal(await readFile(join(repo.path, "file"), "utf8"), "a\nold1\ncontext\nnew2\nz\n")
  })
})
