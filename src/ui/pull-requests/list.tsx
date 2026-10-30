import {
  CheckCircleIcon,
  ClockIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LinkExternalIcon,
  SkipIcon,
  SyncIcon,
  XCircleFillIcon
} from "@primer/octicons-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { canDropCommits, takeCommitDrag } from "@/lib/commit-drag"
import type { IFilterListItem } from "@/lib/filter-list"
import { formatDate } from "@/lib/format-date"
import { ipc } from "@/lib/ipc"
import type { PullRequest, Remote } from "@/models/app-state"
import { getPreferAbsoluteDates } from "@/models/formatting-preferences"
import { Badge } from "@/ui/base/badge"
import { Button, Button as StandardButton } from "@/ui/base/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger
} from "@/ui/base/context-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/base/empty"
import { Input } from "@/ui/base/input"
import { Spinner } from "@/ui/base/spinner"
import { HighlightText } from "@/ui/desktop/highlight-text"
import { SectionFilterList } from "@/ui/desktop/section-filter-list"
import { formatRelative } from "@/upstream/lib/format-relative"
import { match } from "@/upstream/lib/fuzzy-find"

import { NativeChecks } from "../check-runs/native-checks"

interface RequestItem extends IFilterListItem {
  request: PullRequest
}

/** 开放的 PR / MR。
 *
 * 两家的字段名不同（PR vs MR、number vs iid、CI 状态藏的位置也不一样），
 * 在 Rust 那侧已经统一成一套，这里只管画。
 *
 * 「切到这条分支」是最常用的动作——看 PR 多半是为了在本地跑一下。 */
export function PullRequests({
  repo,
  onCherryPick,
  remote,
  onCheckout,
  onCreate
}: {
  repo?: string
  onCherryPick?: (request: PullRequest, target: Remote, shas: string[]) => void
  remote: Remote | null
  onCheckout: (request: PullRequest, target: Remote) => void
  onCreate: () => void
}) {
  const { t } = useTranslation()
  const [list, setList] = useState<PullRequest[]>([])
  const [target, setTarget] = useState<Remote | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 展开哪条 PR 的检查项。一次只展开一条——同时摊开几十个 job 没人看得过来
  const [inspecting, setInspecting] = useState<{ url: string; anchor: HTMLElement } | null>(null)

  const [query, setQuery] = useState("")
  const shown = query.trim()
    ? match(query.trim(), list, pr => [pr.title, `#${pr.number} ${pr.author}`]).map(result => result.item)
    : list

  const groups = useMemo(
    () => [
      {
        identifier: "pull-requests",
        showHeader: false,
        items: list.map(request => ({
          id: request.url,
          text: [request.title, `#${request.number} ${request.author}`],
          request
        }))
      }
    ],
    [list]
  )
  const [selected, setSelected] = useState<RequestItem | null>(null)
  const inspectedRequest = list.find(pr => pr.url === inspecting?.url)

  const [revision, setRevision] = useState(0)
  // revision explicitly triggers a fresh request from the refresh button.
  useEffect(() => {
    let live = true
    setSelected(null)
    setList([])
    setTarget(null)
    setInspecting(null)
    setError(null)
    if (!remote) {
      setBusy(false)
      return
    }
    setBusy(true)
    ipc
      .pullRequestRepository(remote.host, remote.owner, remote.name)
      .then(target => {
        if (!live) return []
        setTarget(target)
        return ipc.pullRequests(target.host, target.owner, target.name, true)
      })
      .then(value => {
        if (live) setList(value)
      })
      .catch((e: unknown) => {
        if (live) setError(String(e))
      })
      .finally(() => {
        if (live) setBusy(false)
      })
    return () => {
      live = false
    }
  }, [remote, revision])

  if (busy) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  // 侧栏只有 250px 宽：单行紧凑，搜索框占满剩余宽度，刷新是图标按钮，页签已经写了「Pull requests」不再重复标题
  const header = (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-2">
      <Input
        className="h-7 min-w-0 flex-1 text-xs"
        value={query}
        onChange={event => setQuery(event.currentTarget.value)}
        placeholder={t("pr.search")}
        aria-label={t("pr.search")}
      />
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {shown.length}/{list.length}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        disabled={!remote}
        title={t("inbox.refresh")}
        aria-label={t("inbox.refresh")}
        onClick={() => setRevision(value => value + 1)}>
        <SyncIcon size={14} />
      </Button>
      <Button size="xs" disabled={!remote} onClick={onCreate}>
        {t("pr.newPr")}
      </Button>
    </div>
  )

  if (!remote || list.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t(error ? "pr.loadFailed" : "pr.empty")}</EmptyTitle>
            <EmptyDescription>{error ?? t("pr.emptyHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <SectionFilterList<RequestItem>
        listRole="list"
        className="native-pull-request-list min-h-0 flex-1"
        rowHeight={47}
        groups={groups}
        filterText={query}
        hideFilterRow
        selectedItem={selected}
        onSelectionChanged={setSelected}
        onItemClick={item => target && onCheckout(item.request, target)}
        getItemAriaLabel={item => `#${item.request.number} ${item.request.title}`}
        getGroupAriaLabel={() => t("pr.title")}
        invalidationProps={list}
        renderNoItems={() => (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("pr.noMatches")}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        renderItem={(item, matches) => {
          const pr = item.request
          const created = pr.createdAt ? new Date(pr.createdAt) : null
          const dateText =
            created && Number.isFinite(created.getTime())
              ? getPreferAbsoluteDates()
                ? formatDate(created)
                : formatRelative(created.getTime() - Date.now())
              : null
          return (
            <ContextMenu>
              <ContextMenuTrigger
                onDragOver={event => {
                  if (!repo || !target || !onCherryPick || !canDropCommits(event.dataTransfer, repo)) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = "copy"
                  event.currentTarget.dataset.dropTarget = "true"
                }}
                onDragLeave={event => {
                  delete event.currentTarget.dataset.dropTarget
                }}
                onDrop={event => {
                  delete event.currentTarget.dataset.dropTarget
                  if (!repo || !target || !onCherryPick) return
                  const shas = takeCommitDrag(event.dataTransfer, repo)
                  if (!shas) return
                  event.preventDefault()
                  event.stopPropagation()
                  onCherryPick(pr, target, shas)
                }}
                className="hover:bg-accent/50 data-[drop-target=true]:bg-accent flex h-full min-w-0 flex-1 items-center gap-3 px-3">
                {pr.draft ? (
                  <GitPullRequestDraftIcon size={16} className="text-muted-foreground shrink-0" />
                ) : (
                  <GitPullRequestIcon size={16} className="text-status-new shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <StandardButton
                    variant="ghost"
                    type="button"
                    onKeyDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation()
                      void openUrl(pr.url)
                    }}
                    className="flex h-auto max-w-full items-center gap-1 p-0 text-sm font-medium hover:underline">
                    <span className="truncate">
                      <HighlightText text={pr.title} highlight={matches.title} />
                    </span>
                    {pr.draft && <Badge variant="secondary">{t("pr.draft")}</Badge>}
                    <LinkExternalIcon size={12} className="text-muted-foreground shrink-0" />
                  </StandardButton>
                  <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
                    <span className="shrink-0">#{pr.number}</span>
                    <span
                      className="truncate"
                      title={dateText ? t("pr.opened", { date: dateText, author: pr.author }) : pr.author}>
                      {dateText ? t("pr.opened", { date: dateText, author: pr.author }) : pr.author}
                    </span>
                    <Checks state={pr.checks} />
                    {pr.checks && remote && pr.headSha && (
                      <StandardButton
                        variant="ghost"
                        type="button"
                        className="h-auto shrink-0 p-0 underline-offset-2 hover:underline"
                        onClick={event => {
                          event.stopPropagation()
                          setInspecting(
                            inspecting?.url === pr.url ? null : { url: pr.url, anchor: event.currentTarget }
                          )
                        }}>
                        {t("pr.checksDetail")}
                      </StandardButton>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!target}
                  onClick={event => {
                    event.stopPropagation()
                    if (target) onCheckout(pr, target)
                  }}>
                  {t("pr.checkout")}
                </Button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuGroup>
                  <ContextMenuItem
                    onClick={event => {
                      event.stopPropagation()
                      void openUrl(pr.url)
                    }}>
                    {t("pr.viewOnline")}
                  </ContextMenuItem>
                </ContextMenuGroup>
              </ContextMenuContent>
            </ContextMenu>
          )
        }}
      />
      {inspecting && inspectedRequest && target && (
        <NativeChecks
          key={`${target.host}/${target.owner}/${target.name}/${inspectedRequest.headSha}`}
          remote={target}
          request={inspectedRequest}
          anchor={inspecting.anchor}
          onClose={() => setInspecting(null)}
        />
      )}
    </div>
  )
}

/** CI 状态。用图标而不是文字：一屏十几条 PR 时，颜色和形状比读字快。 */
function Checks({ state }: { state: string | null }) {
  if (!state) return null
  if (state === "success") return <CheckCircleIcon size={12} className="text-status-new shrink-0" />
  if (state === "failure" || state === "timed_out")
    return <XCircleFillIcon size={12} className="text-destructive shrink-0" />
  // skipped / cancelled 这类既不算成功也不算失败，用中性色
  if (state === "skipped" || state === "cancelled")
    return <SkipIcon size={12} className="text-muted-foreground shrink-0" />
  return <ClockIcon size={12} className="text-status-modified shrink-0" />
}
