import { GitCommitIcon, TagIcon } from "@primer/octicons-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"

import { autolinkRefSets, type HostingPlatform, linkifyTokens } from "@/lib/autolink-rules"
import type { RefSet } from "@/lib/autolinks"
import { avatarUrl } from "@/lib/avatar"
import { changesetLineCounts, showsLineCounts } from "@/lib/commit-line-counts"
import { type TokenResult, TokenType } from "@/lib/text-token-parser"
import { cn } from "@/lib/utils"
import type { AutolinkRule, Remote } from "@/models/app-state"
import type { CommitFile, CommitInfo } from "@/models/history"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"

/** 提交摘要，横跨右侧整宽，位于文件列表和 diff 之上。
 *
 * 对应 Desktop 的 ExpandableCommitSummary（`_expandable-commit-summary.scss`）：标题 14px semibold 行高 16px、
 * 四周 10px；正文等宽 11px 保留换行；元信息行 11px，依次是头像+作者、提交图标+短 SHA、
 * 增删行数（renderLinesChanged：`+N` 新增色、`-M` 删除色，各右留 5px，两数都是 0 时不显示）、标签。
 * 日期是本项目额外显示的，放在行尾。另外把 `#123` 变成可点的链接——
 * 提交信息里引用 issue 是常态，为了看一眼 123 是什么而跳去浏览器手动搜，
 * 是每天都在发生的打断。设置里的自动链接规则（JIRA-123 之类）和 GitLab 远端的
 * `#1` / `!1` 内置引用走 GitLens 的 autolinks 移植。 */
export function CommitSummary({
  commit,
  remote,
  platform = "github",
  rules = [],
  files = []
}: {
  commit: CommitInfo
  /** 没有远端时 `#123` 无处可跳，就按普通文字显示 */
  remote?: Remote | null
  /** GitLab 远端用 `/-/issues/<num>` 与 `!<num>` 内置引用，GitHub 沿用 Desktop 的 `#<num>` */
  platform?: HostingPlatform
  /** 设置里的自动链接规则 */
  rules?: ReadonlyArray<AutolinkRule>
  /** 这次提交的改动集（带 numstat）；增删行数由它累加 */
  files?: ReadonlyArray<CommitFile>
}) {
  const { t } = useTranslation()
  const refsets = useMemo(
    () => autolinkRefSets(rules, remote ?? null, platform, (key, options) => t(key, options)),
    [rules, remote, platform, t]
  )
  const lines = changesetLineCounts(files)
  return (
    <div className="min-w-0 shrink-0 overflow-hidden">
      <div className="flex flex-col gap-[5px] p-2.5">
        <p className={cn("text-sm leading-4 font-semibold wrap-anywhere", !commit.summary && "text-muted-foreground")}>
          {commit.summary ? (
            <Linkified text={commit.summary} remote={remote} platform={platform} refsets={refsets} />
          ) : (
            t("history.emptySummary")
          )}
        </p>
        {commit.body && (
          <p className="font-mono text-[11px] wrap-anywhere whitespace-pre-wrap">
            <Linkified text={commit.body} remote={remote} platform={platform} refsets={refsets} />
          </p>
        )}
        <p className="flex min-w-0 items-center gap-2.5 text-[11px]">
          <span className="flex min-w-0 items-center gap-1" title={`${commit.authorName} <${commit.authorEmail}>`}>
            <Avatar size="sm" className="data-[size=sm]:size-4">
              <AvatarImage src={avatarUrl(commit.authorEmail, 32)} alt={commit.authorName} loading="lazy" />
              <AvatarFallback className="text-foreground group-data-[size=sm]/avatar:text-[10px]">
                {commit.authorName.trim().slice(0, 1).toUpperCase() || "?"}
              </AvatarFallback>
            </Avatar>
            <span className="truncate">{commit.authorName}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1" title={commit.sha}>
            <GitCommitIcon size={16} />
            <span className="font-mono select-text">{commit.shortSha}</span>
          </span>
          {showsLineCounts(lines) && (
            <span className="lines-added-deleted flex shrink-0 items-center">
              <span className="text-status-new pr-[5px]">+{lines.linesAdded}</span>
              <span className="text-status-deleted pr-[5px]">-{lines.linesDeleted}</span>
            </span>
          )}
          {commit.tags.length > 0 && (
            <span className="flex min-w-0 items-center gap-1" title={commit.tags.join(", ")}>
              <TagIcon size={16} className="shrink-0" />
              <span className="truncate">{commit.tags.join(", ")}</span>
            </span>
          )}
          <span
            className="text-muted-foreground ml-auto shrink-0"
            title={new Date(commit.time * 1000).toLocaleString()}>
            {new Date(commit.time * 1000).toLocaleString()}
          </span>
        </p>
      </div>
      <Separator />
    </div>
  )
}

/** 把 `#123` 换成链接，其余原样。
 *
 * 只认独立的 `#数字`：`#1` 要匹配，而 `abc#1`（比如 URL 片段、`issue#1`）不该
 * 被当成引用。GitLab 远端的 `#1` 由内置引用接管（URL 是 `/-/issues/`），这里不再拆。 */
function issueTokens(text: string, remote: Remote | null | undefined, platform: HostingPlatform): TokenResult[] {
  if (!remote || platform === "gitlab") return [{ kind: TokenType.Text, text }]

  return text.split(/(?<![\w/])#(\d+)\b/g).flatMap((part, i): TokenResult[] => {
    // split 带捕获组时，奇数位就是捕获到的数字
    if (i % 2 === 0) return part ? [{ kind: TokenType.Text, text: part }] : []
    const url = `https://${remote.host}/${remote.owner}/${remote.name}/issues/${part}`
    return [{ kind: TokenType.Link, text: `#${part}`, url }]
  })
}

function Linkified({
  text,
  remote,
  platform,
  refsets
}: {
  text: string
  remote?: Remote | null
  platform: HostingPlatform
  refsets: ReadonlyArray<RefSet>
}) {
  const tokens = linkifyTokens(issueTokens(text, remote, platform), refsets)
  return (
    <>
      {tokens.map((token, i) => {
        if (token.kind === TokenType.Text) return token.text
        if (token.kind === TokenType.Emoji) return token.text
        return (
          <a
            // 文本片段的位置区分同一正文中重复的引用。
            key={`${token.text}-${i}`}
            href={token.url}
            title={token.kind === "autolink" ? token.title : undefined}
            onClick={event => {
              event.preventDefault()
              void openUrl(token.url)
            }}
            className="text-primary underline underline-offset-2">
            {token.text}
          </a>
        )
      })}
    </>
  )
}
