import type { AutolinkRule, Remote } from "../models/app-state"
import {
  type CacheableAutolinkReference,
  ensureCachedRegex,
  getAutolinks,
  isCacheable,
  numRegex,
  type RefSet
} from "./autolinks"
import { type TokenResult, TokenType } from "./text-token-parser"

/** 规则校验：前缀和 URL 必填，URL 里要有 `<num>` 占位。 */
export interface AutolinkRuleErrors {
  prefix?: "required"
  url?: "required" | "num"
}

export function validateAutolinkRule(rule: AutolinkRule): AutolinkRuleErrors | null {
  const errors: AutolinkRuleErrors = {}
  if (!rule.prefix) errors.prefix = "required"
  if (!rule.url) errors.url = "required"
  else if (!rule.url.includes("<num>")) errors.url = "num"
  return errors.prefix || errors.url ? errors : null
}

export type HostingPlatform = "github" | "gitlab"

export type Translate = (key: string, options?: Record<string, string>) => string

/** GitLens packages/git/src/remotes/gitlab.ts (c1f6e5f3c) 的内置引用：`#<num>` issue 与 `!<num>` 合并请求。
 * 上游的 `owner/repo#1` / `owner/repo!1` 动态引用没有搬。 */
export function gitlabAutolinks(remote: Remote, t: Translate): CacheableAutolinkReference[] {
  const baseUrl = `https://${remote.host}/${remote.owner}/${remote.name}`
  return [
    {
      prefix: "#",
      url: `${baseUrl}/-/issues/<num>`,
      alphanumeric: false,
      ignoreCase: false,
      title: t("autolinks.gitlabIssue", { num: "<num>" }),
      type: "issue",
      description: t("autolinks.gitlabIssueDescription", { num: "<num>" })
    },
    {
      prefix: "!",
      url: `${baseUrl}/-/merge_requests/<num>`,
      alphanumeric: false,
      ignoreCase: false,
      title: t("autolinks.gitlabMergeRequest", { num: "<num>" }),
      type: "pullrequest",
      description: t("autolinks.gitlabMergeRequestDescription", { num: "<num>" })
    }
  ]
}

/** 用户规则在前，GitLab 远端再追加内置引用；GitHub 的 `#1` 由 Desktop 的分词器处理，这里不重复。 */
export function autolinkRefSets(
  rules: ReadonlyArray<AutolinkRule>,
  remote: Remote | null,
  platform: HostingPlatform,
  t: Translate
): RefSet[] {
  const refsets: RefSet[] = []
  const valid = rules.filter(rule => validateAutolinkRule(rule) === null)
  if (valid.length) {
    refsets.push([
      undefined,
      valid.map(rule => ({
        prefix: rule.prefix,
        url: rule.url,
        alphanumeric: rule.alphanumeric,
        ignoreCase: rule.ignoreCase,
        title: rule.title || undefined
      }))
    ])
  }
  if (remote && platform === "gitlab") {
    refsets.push([{ id: "gitlab", name: "GitLab", domain: remote.host, icon: "gitlab" }, gitlabAutolinks(remote, t)])
  }
  return refsets
}

export interface AutolinkSpan {
  start: number
  end: number
  text: string
  url: string
  title: string | undefined
}

/** 文本里每个可链接引用的位置。匹配规则与 `getAutolinks` 相同：同一个缓存的 messageRegex、
 * 同样跳过非提交引用；位置按引用顺序先到先得，重叠的后者丢弃。 */
export function findAutolinkSpans(text: string, refsets: Readonly<RefSet[]>): AutolinkSpan[] {
  if (!text || getAutolinks(text, refsets).size === 0) return []
  const spans: AutolinkSpan[] = []
  for (const [, refs] of refsets) {
    for (const ref of refs) {
      if (!isCacheable(ref) || (ref.referenceType && ref.referenceType !== "commit")) continue
      ensureCachedRegex(ref, "plaintext")
      const regex = ref.messageRegex
      regex.lastIndex = 0
      let match
      while ((match = regex.exec(text))) {
        const [, lead, linkText, num] = match
        const start = match.index + lead.length
        const end = start + linkText.length
        if (spans.some(span => start < span.end && end > span.start)) continue
        spans.push({
          start,
          end,
          text: linkText,
          url: ref.url.replace(numRegex, num),
          title: ref.title?.replace(numRegex, num)
        })
      }
    }
  }
  return spans.toSorted((a, b) => a.start - b.start)
}

export type AutolinkToken = {
  readonly kind: "autolink"
  readonly text: string
  readonly url: string
  readonly title: string | undefined
}

export type LinkifiedToken = TokenResult | AutolinkToken

/** 在 Desktop 分词之后跑：只拆纯文本片段，emoji、issue、@提及和 URL 原样保留。 */
export function linkifyTokens(tokens: ReadonlyArray<TokenResult>, refsets: Readonly<RefSet[]>): LinkifiedToken[] {
  if (!refsets.length) return [...tokens]
  const result: LinkifiedToken[] = []
  for (const token of tokens) {
    if (token.kind !== TokenType.Text) {
      result.push(token)
      continue
    }
    let cursor = 0
    for (const span of findAutolinkSpans(token.text, refsets)) {
      if (span.start > cursor) result.push({ kind: TokenType.Text, text: token.text.slice(cursor, span.start) })
      result.push({ kind: "autolink", text: span.text, url: span.url, title: span.title })
      cursor = span.end
    }
    if (cursor < token.text.length) result.push({ kind: TokenType.Text, text: token.text.slice(cursor) })
  }
  return result
}
