import assert from "node:assert/strict"
import { it } from "node:test"

import {
  autolinkRefSets,
  findAutolinkSpans,
  gitlabAutolinks,
  linkifyTokens,
  validateAutolinkRule
} from "../../src/lib/autolink-rules"
import { Tokenizer, TokenType } from "../../src/lib/text-token-parser"
import type { AutolinkRule, Remote } from "../../src/models/app-state"

const t = (key: string, options?: Record<string, string>) => `${key}:${options?.num ?? ""}`
const jira: AutolinkRule = {
  prefix: "JIRA-",
  url: "https://jira.example.com/browse/JIRA-<num>",
  alphanumeric: false,
  ignoreCase: false,
  title: "Issue <num>"
}
const github: Remote = { host: "github.com", owner: "gitcub", name: "gitcub" }
const gitlab: Remote = { host: "gitlab.example", owner: "group/subgroup", name: "project" }

it("linkifies a custom rule inside a commit message and keeps the rest as text", () => {
  const refsets = autolinkRefSets([jira], github, "github", t)
  const tokens = linkifyTokens(new Tokenizer(new Map()).tokenize("Fixes JIRA-123 (JIRA-7) and jira-9"), refsets)
  assert.deepEqual(tokens, [
    { kind: TokenType.Text, text: "Fixes " },
    { kind: "autolink", text: "JIRA-123", url: "https://jira.example.com/browse/JIRA-123", title: "Issue 123" },
    { kind: TokenType.Text, text: " (" },
    { kind: "autolink", text: "JIRA-7", url: "https://jira.example.com/browse/JIRA-7", title: "Issue 7" },
    { kind: TokenType.Text, text: ") and jira-9" }
  ])
})

it("links !12 to the merge request only on a GitLab remote", () => {
  const message = "Merge !12 fixes #5"
  const onGitLab = findAutolinkSpans(message, autolinkRefSets([], gitlab, "gitlab", t))
  assert.deepEqual(
    onGitLab.map(span => [span.text, span.url, span.title]),
    [
      ["!12", "https://gitlab.example/group/subgroup/project/-/merge_requests/12", "autolinks.gitlabMergeRequest:12"],
      ["#5", "https://gitlab.example/group/subgroup/project/-/issues/5", "autolinks.gitlabIssue:5"]
    ]
  )
  assert.deepEqual(findAutolinkSpans(message, autolinkRefSets([], github, "github", t)), [])
  assert.deepEqual(findAutolinkSpans(message, autolinkRefSets([], null, "gitlab", t)), [])
  assert.deepEqual(
    gitlabAutolinks(gitlab, t).map(ref => [ref.prefix, ref.type]),
    [
      ["#", "issue"],
      ["!", "pullrequest"]
    ]
  )
})

it("leaves Desktop's GitHub issue, mention, emoji and URL tokens untouched", () => {
  const emoji = new Map([[":tada:", { url: "tada.png", emoji: "🎉", aliases: ["tada"], description: "tada" }]])
  const tokenizer = new Tokenizer(emoji)
  const before = tokenizer.tokenize(":tada: see https://github.com/gitcub/gitcub/issues/1 JIRA-1")
  const after = linkifyTokens(before, autolinkRefSets([jira], github, "github", t))
  assert.deepEqual(after.slice(0, -2), before.slice(0, -1))
  assert.deepEqual(after.at(-1), {
    kind: "autolink",
    text: "JIRA-1",
    url: "https://jira.example.com/browse/JIRA-1",
    title: "Issue 1"
  })
  assert.deepEqual(linkifyTokens(before, []), before)
})

it("validates prefix, URL and the <num> placeholder", () => {
  assert.equal(validateAutolinkRule(jira), null)
  assert.deepEqual(validateAutolinkRule({ ...jira, prefix: "" }), { prefix: "required" })
  assert.deepEqual(validateAutolinkRule({ ...jira, url: "" }), { url: "required" })
  assert.deepEqual(validateAutolinkRule({ ...jira, url: "https://jira.example.com/browse/" }), { url: "num" })
  assert.deepEqual(validateAutolinkRule({ ...jira, prefix: "", url: "" }), { prefix: "required", url: "required" })
  assert.deepEqual(autolinkRefSets([{ ...jira, url: "" }], github, "github", t), [])
})

it("matches alphanumeric ids and ignores case when the rule says so", () => {
  const rule: AutolinkRule = { ...jira, alphanumeric: true, ignoreCase: true, title: "" }
  const spans = findAutolinkSpans("jira-ab12 then JIRA-xyz", autolinkRefSets([rule], null, "github", t))
  assert.deepEqual(
    spans.map(span => [span.text, span.url, span.title]),
    [
      ["jira-ab12", "https://jira.example.com/browse/JIRA-ab12", undefined],
      ["JIRA-xyz", "https://jira.example.com/browse/JIRA-xyz", undefined]
    ]
  )
})
