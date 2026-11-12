import type { AutolinkRule, Remote } from "../models/app-state"
import {
  type Autolink,
  type AutolinkReference,
  type DynamicAutolinkReference,
  ensureCachedRegex,
  getAutolinks,
  isCacheable,
  isDynamic,
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

// GitLens packages/git/src/remotes/github.ts (4a58ac0b4)：GitHub 只有 owner/repo 两段
const autolinkFullIssuesRegex = /\b([^/\s]+\/[^/\s]+?)(?:\\)?#([0-9]+)\b(?!]\()/g
// GitLens packages/git/src/remotes/gitlab.ts (4a58ac0b4, f168f8dd1)：GitLab 的命名空间可以嵌套多级子组
const gitlabAutolinkFullIssuesRegex = /\b((?:[^/\s]+\/)+[^/\s]+?)(?:\\)?#([0-9]+)\b(?!]\()/g
const gitlabAutolinkFullMergeRequestsRegex = /\b((?:[^/\s]+\/)+[^/\s]+?)(?:\\)?!([0-9]+)\b(?!]\()/g

/** GitLens 的 `owner/repo#1` 动态引用：parse 进结果表，descriptor 供渲染定位链接 */
function fullReference(
  regex: RegExp,
  url: (repo: string, num: string) => string,
  title: (repo: string, num: string) => string,
  label: (repo: string, num: string) => string,
  separator: "#" | "!",
  type?: Autolink["type"]
): DynamicAutolinkReference {
  return {
    descriptors: [{ regex, url, title, label }],
    parse: (text: string, autolinks: Map<string, Autolink>) => {
      let match
      while ((match = regex.exec(text))) {
        const [, ownerAndRepo, num] = match
        autolinks.set(num, {
          id: num,
          prefix: `${ownerAndRepo}${separator}`,
          url: url(ownerAndRepo, num),
          alphanumeric: false,
          ignoreCase: true,
          title: title(ownerAndRepo, "<num>"),
          type,
          description: label(ownerAndRepo, num)
        })
      }
    }
  }
}

/** GitLens github.ts 的内置引用：`GH-<num>` 与 `owner/repo#<num>`；`#<num>` 留给 Desktop 的分词器 */
export function githubAutolinks(remote: Remote, t: Translate): (AutolinkReference | DynamicAutolinkReference)[] {
  const baseUrl = `https://${remote.host}/${remote.owner}/${remote.name}`
  return [
    {
      prefix: "gh-",
      url: `${baseUrl}/issues/<num>`,
      alphanumeric: false,
      ignoreCase: true,
      title: t("autolinks.openIssueOrPullRequestOnGitHub", { num: "<num>" }),
      description: t("autolinks.gitHubIssueOrPullRequest", { num: "<num>" })
    },
    fullReference(
      autolinkFullIssuesRegex,
      (repo, num) => `https://${remote.host}/${repo}/issues/${num}`,
      (repo, num) => t("autolinks.openIssueOrPullRequestFromRepositoryOnGitHub", { num, repository: repo }),
      (repo, num) => t("autolinks.gitHubIssueOrPullRequestInRepository", { num, repository: repo }),
      "#"
    )
  ]
}

/** GitLens gitlab.ts 的内置引用：`#<num>` issue、`!<num>` 合并请求，以及 `owner/repo#<num>` / `owner/repo!<num>` */
export function gitlabAutolinks(remote: Remote, t: Translate): (AutolinkReference | DynamicAutolinkReference)[] {
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
    },
    fullReference(
      gitlabAutolinkFullIssuesRegex,
      (repo, num) => `https://${remote.host}/${repo}/-/issues/${num}`,
      (repo, num) => t("autolinks.openIssueFromRepositoryOnGitLab", { num, repository: repo }),
      (repo, num) => t("autolinks.gitLabIssueInRepository", { num, repository: repo }),
      "#",
      "issue"
    ),
    fullReference(
      gitlabAutolinkFullMergeRequestsRegex,
      (repo, num) => `https://${remote.host}/${repo}/-/merge_requests/${num}`,
      (repo, num) => t("autolinks.openMergeRequestFromRepositoryOnGitLab", { num, repository: repo }),
      (repo, num) => t("autolinks.gitLabMergeRequestInRepository", { num, repository: repo }),
      "!",
      "pullrequest"
    )
  ]
}

/** 用户规则在前，再追加远端平台的内置引用；GitHub 的 `#1` 由 Desktop 的分词器处理，这里不重复。 */
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
  } else if (remote) {
    refsets.push([{ id: "github", name: "GitHub", domain: remote.host, icon: "github" }, githubAutolinks(remote, t)])
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
 * 同样跳过非提交引用；动态引用照 GitLens autolinksProvider 的 linkify 用 descriptor 的正则定位。
 * 位置按引用顺序先到先得，重叠的后者丢弃。 */
export function findAutolinkSpans(text: string, refsets: Readonly<RefSet[]>): AutolinkSpan[] {
  if (!text || getAutolinks(text, refsets).size === 0) return []
  const spans: AutolinkSpan[] = []
  for (const [, refs] of refsets) {
    for (const ref of refs) {
      if (isDynamic(ref)) {
        for (const desc of ref.descriptors ?? []) {
          desc.regex.lastIndex = 0
          let match
          while ((match = desc.regex.exec(text))) {
            const [linkText, repo, num] = match
            const start = match.index
            const end = start + linkText.length
            if (spans.some(span => start < span.end && end > span.start)) continue
            spans.push({ start, end, text: linkText, url: desc.url(repo, num), title: desc.title(repo, num) })
          }
        }
        continue
      }
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
