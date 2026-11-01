// Desktop MIT port of ui/history/expandable-commit-summary.tsx; written as a function component.
// 单个提交的部分（标题、展开、描述、作者、SHA、增删行数、标签）照原版；多选与「不可达提交」由本项目
// 的历史列表另行处理，这里只接单个提交。文字渲染沿用本项目的 issue / GitLens autolink 链接。
import { openUrl } from "@tauri-apps/plugin-opener"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { autolinkRefSets, type HostingPlatform, linkifyTokens } from "@/lib/autolink-rules"
import type { RefSet } from "@/lib/autolinks"
import { getDesktopRuntime } from "@/lib/desktop-runtime"
import { type Tokenizer, type TokenResult, TokenType } from "@/lib/text-token-parser"
import { wrapRichTextCommitMessage } from "@/lib/wrap-rich-text-commit-message"
import type { AutolinkRule, Remote } from "@/models/app-state"
import { getAvatarUsersForCommit, type IAvatarUser } from "@/models/avatar"
import type { Commit } from "@/models/commit"

import { CommitAttribution } from "../changes/commit-attribution"
import { CopyButton } from "../copy-button"
import { Avatar } from "../desktop/avatar"
import { AvatarStack } from "../desktop/avatar-stack"
import { Button } from "../desktop/button"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"

interface IExpandableCommitSummaryProps {
  readonly commit: Commit
  readonly linesAdded: number
  readonly linesDeleted: number

  /**
   * Whether or not the commit body container should
   * be rendered expanded or not. In expanded mode the
   * commit body container takes over the diff view
   * allowing for full height, scrollable reading of
   * the commit message body.
   */
  readonly isExpanded: boolean

  readonly onExpandChanged: (isExpanded: boolean) => void

  /** 没有远端时 `#123` 无处可跳，就按普通文字显示 */
  readonly remote?: Remote | null
  /** GitLab 远端用 `/-/issues/<num>` 与 `!<num>` 内置引用，GitHub 沿用 Desktop 的 `#<num>` */
  readonly platform?: HostingPlatform
  /** 设置里的自动链接规则 */
  readonly rules?: ReadonlyArray<AutolinkRule>
}

/** 原版用 Tokenizer 切 issue 与 emoji；本项目的链接在 Linkified 里另做，这里只要按 72 字符折行 */
const plainTokenizer = { tokenize: (text: string) => [{ kind: TokenType.Text, text }] } as unknown as Tokenizer
const tokensText = (tokens: ReadonlyArray<TokenResult>) => tokens.map(token => token.text).join("")

export function ExpandableCommitSummary({
  commit,
  linesAdded,
  linesDeleted,
  isExpanded,
  onExpandChanged,
  remote,
  platform = "github",
  rules = []
}: IExpandableCommitSummaryProps) {
  const { t } = useTranslation()
  const accounts = getDesktopRuntime().appStore.getState().accounts
  const descriptionScrollView = useRef<HTMLDivElement | null>(null)
  const [isOverflowed, setIsOverflowed] = useState(false)

  // Desktop createState：摘要超过 72 字符时多出的部分折进正文
  const { summary, body } = useMemo(() => {
    const wrapped = wrapRichTextCommitMessage(
      commit.summary.length === 0 ? t("history.emptyCommitMessage") : commit.summary,
      commit.body,
      plainTokenizer
    )
    return { summary: tokensText(wrapped.summary), body: tokensText(wrapped.body) }
  }, [commit.summary, commit.body, t])
  const hasEmptySummary = commit.summary.length === 0
  const avatarUsers = useMemo(() => uniqueAvatarUsers(getAvatarUsersForCommit(null, commit)), [commit])
  const refsets = useMemo(
    () => autolinkRefSets(rules, remote ?? null, platform, (key, options) => t(key, options)),
    [rules, remote, platform, t]
  )

  // Desktop updateOverflow：描述超出折叠高度才算溢出；展开时不需要
  const updateOverflow = () => {
    const scrollView = descriptionScrollView.current
    setIsOverflowed(scrollView ? scrollView.scrollHeight > scrollView.offsetHeight : false)
  }
  useLayoutEffect(() => {
    if (isExpanded) setIsOverflowed(false)
    else updateOverflow()
  }, [isExpanded, body])
  useEffect(() => {
    const scrollView = descriptionScrollView.current
    if (!scrollView) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      // 在尺寸回调里改状态可能引起递归更新，推到下一帧
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!isExpanded) updateOverflow()
      })
    })
    observer.observe(scrollView)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [isExpanded, body])

  const onCollapse = () => {
    if (descriptionScrollView.current) descriptionScrollView.current.scrollTop = 0
    onExpandChanged(false)
  }

  const renderExpandedAuthor = (user: IAvatarUser | undefined) => {
    if (!user) return t("history.unknownUser")
    if (user.name) return `${user.name} <${user.email}>`
    return user.email
  }

  return (
    <div id="expandable-commit-summary" className={isExpanded ? "expanded" : undefined}>
      <div className={hasEmptySummary ? "ecs-title empty-summary" : "ecs-title"}>
        <span className="selectable">
          <Linkified text={summary} remote={remote} platform={platform} refsets={refsets} />
        </span>
        <Button
          onClick={isExpanded ? onCollapse : () => onExpandChanged(true)}
          // Desktop 去掉了按钮默认样式；shadcn 的尺寸在 utilities 层，得在这里覆盖
          className="expander size-auto border-none bg-transparent p-0 hover:bg-transparent dark:hover:bg-transparent"
          tooltip={isExpanded ? t("history.collapse") : t("history.expand")}
          applyTooltipAriaDescribedBy={false}
          ariaExpanded={isExpanded}
          ariaLabel={isExpanded ? t("history.collapseCommitDetails") : t("history.expandCommitDetails")}
          ariaControls="expandable-commit-summary">
          <Octicon symbol={isExpanded ? octicons.fold : octicons.unfold} />
        </Button>
      </div>
      <div className="beneath-summary">
        {body.length > 0 && (
          <div className={isOverflowed ? "ecs-description overflowed" : "ecs-description"}>
            <div className="ecs-description-scroll-view" ref={descriptionScrollView}>
              <div className="ecs-description-text selectable">
                <Linkified text={body} remote={remote} platform={platform} refsets={refsets} />
              </div>
            </div>
          </div>
        )}
        <div className="ecs-meta">
          <div className="ecs-meta-item authors">
            {isExpanded ? (
              avatarUsers.map((user, i) => (
                <div className="author selectable" key={i}>
                  <Avatar accounts={accounts} user={user} title={null} className="size-4" />
                  <div>{renderExpandedAuthor(user)}</div>
                </div>
              ))
            ) : (
              <>
                <AvatarStack users={avatarUsers} accounts={accounts} />
                <CommitAttribution avatarUsers={avatarUsers} />
              </>
            )}
          </div>
          <div className="ecs-meta-item commit-ref">
            <Octicon symbol={octicons.gitCommit} />
            <div className="ref selectable">{isExpanded ? commit.sha : commit.shortSha}</div>
            <CopyButton
              ariaLabel={t("history.copyTheFullSha")}
              copyContent={commit.sha}
              className="size-auto min-w-4 border-none bg-transparent p-0 hover:bg-transparent dark:hover:bg-transparent [&_svg]:size-3"
            />
          </div>
          {(linesAdded !== 0 || linesDeleted !== 0) && (
            <div className="ecs-meta-item lines-added-deleted">
              {isExpanded ? <Octicon symbol={octicons.diff} /> : null}
              <div className="lines-added">
                {isExpanded ? t("history.addedLines", { count: linesAdded }) : `+${linesAdded}`}
              </div>
              <div className="lines-deleted">
                {isExpanded ? t("history.removedLines", { count: linesDeleted }) : `-${linesDeleted}`}
              </div>
            </div>
          )}
          {commit.tags.length > 0 && (
            <div className="ecs-meta-item tags selectable">
              <Octicon symbol={octicons.tag} />
              <span>{commit.tags.join(", ")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Desktop createState 的 uniqWith：同名同邮箱只留一个 */
function uniqueAvatarUsers(users: ReadonlyArray<IAvatarUser>) {
  return users.filter(
    (user, index) => users.findIndex(other => other.email === user.email && other.name === user.name) === index
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
            className="link-button-component">
            {token.text}
          </a>
        )
      })}
    </>
  )
}
