import assert from "node:assert/strict"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
// GitCub 自有回归，不计入原版上游测试数。
import { describe, it } from "node:test"

import { tokenize } from "../../src/lib/highlighter/worker"
import type { ITokens } from "../../src/upstream/lib/highlighter/types"

/** 高亮 worker 的词法输出快照。
 *
 * 快照由旧实现（@codemirror/lang-* 的 LanguageSupport + EditorState）生成，
 * 用来证明直接拼 @lezer 解析器后每一行的 class 名完全不变。
 * 更新快照：HIGHLIGHTER_SNAPSHOT=update bun test tests/conformance/highlighter.test.ts */
const fixtures = join(import.meta.dirname, "fixtures", "highlighter")
const snapshotPath = join(fixtures, "tokens.snapshot.json")

type Snapshot = Record<string, ITokens | null>

async function collect(): Promise<Snapshot> {
  const names = (await readdir(fixtures)).filter(n => n !== "tokens.snapshot.json").toSorted()
  const out: Snapshot = {}
  for (const name of names) out[name] = tokenize(await readFile(join(fixtures, name), "utf8"), `dir/sub/${name}`)
  return out
}

describe("highlighter tokenize snapshot", () => {
  it("produces the same tokens per line as the recorded snapshot", async () => {
    const actual = await collect()
    if (process.env.HIGHLIGHTER_SNAPSHOT === "update") {
      await writeFile(snapshotPath, `${JSON.stringify(actual, null, 2)}\n`)
      return
    }
    const expected: Snapshot = JSON.parse(await readFile(snapshotPath, "utf8"))
    assert.deepEqual(Object.keys(actual), Object.keys(expected))
    for (const name of Object.keys(expected)) assert.deepEqual(actual[name], expected[name], name)
  })
  it("highlights every supported extension and skips unknown ones", async () => {
    const actual = await collect()
    for (const [name, tokens] of Object.entries(actual)) {
      if (name === "sample.txt" || name === "Dockerfile") assert.equal(tokens, null, name)
      else assert.ok(tokens && Object.keys(tokens).length > 0, name)
    }
  })
  it("splits multi-line tokens per line without crossing newlines", async () => {
    const content = await readFile(join(fixtures, "sample.js"), "utf8")
    const lines = content.split("\n")
    const tokens = tokenize(content, "sample.js")
    assert.ok(tokens)
    for (const [line, bucket] of Object.entries(tokens)) {
      for (const start of Object.keys(bucket)) {
        const token = bucket[Number(start)]
        assert.ok(Number(start) + token.length <= lines[Number(line)].length, `${line}:${start}`)
      }
    }
    assert.equal(tokens[3][0].token, "tok-comment")
    assert.equal(tokens[4][0].token, "tok-comment")
  })
})
