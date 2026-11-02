import assert from "node:assert/strict"
import { it } from "node:test"

import { TerminalOutputDecoder } from "../../src/lib/terminal-output-decoder"

it("keeps interleaved pipes from completing each other’s UTF-8 sequences", () => {
  const decoder = new TerminalOutputDecoder()
  assert.equal(decoder.push({ stream: "stdout", bytes: [0xe4] }), "")
  assert.equal(decoder.push({ stream: "stderr", bytes: [0x65, 0x72, 0x72, 0x0a] }), "err\n")
  assert.equal(decoder.push({ stream: "stdout", bytes: [0xb8, 0xad] }), "中")
  assert.equal(decoder.finish(), "")
})
it("flushes incomplete UTF-8 at EOF separately for both pipes", () => {
  const decoder = new TerminalOutputDecoder()
  decoder.push({ stream: "stdout", bytes: [0xe4] })
  decoder.push({ stream: "stderr", bytes: [0xf0, 0x9f] })
  assert.equal(decoder.finish(), "��")
  assert.equal(decoder.finish(), "")
})
