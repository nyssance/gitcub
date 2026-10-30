import {
  CheckCircleFillIcon,
  DotFillIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  SkipIcon,
  SyncIcon,
  XCircleFillIcon
} from "@primer/octicons-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import type { TFunction } from "i18next"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { usePullRequestsStore } from "@/features/pull-requests/store"
import { canDropCommits, takeCommitDrag } from "@/lib/commit-drag"
import type { IFilterListItem } from "@/lib/filter-list"
import { formatDate } from "@/lib/format-date"
import type { PullRequest, Remote } from "@/models/app-state"
import { getPreferAbsoluteDates } from "@/models/formatting-preferences"
import { Button } from "@/ui/base/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger
} from "@/ui/base/context-menu"
import { Spinner } from "@/ui/base/spinner"
import { NoPullRequests } from "@/ui/branches/no-pull-requests"
import { HighlightText } from "@/ui/desktop/highlight-text"
import { SectionFilterList } from "@/ui/desktop/section-filter-list"
import { TooltippedContent } from "@/ui/desktop/tooltipped-content"
import { formatRelative } from "@/upstream/lib/format-relative"

import { NativeChecks } from "../check-runs/native-checks"

interface IPullRequestListItem extends IFilterListItem {
  readonly id: string
  readonly text: ReadonlyArray<string>
  readonly pullRequest: PullRequest
}

/** Desktop pull-request-list.tsx RowHeight */
export const RowHeight = 47

/** Desktop getSubtitle：`#12 opened 2 days ago by bear`（草稿再加「• Draft」） */
function getSubtitle(pr: PullRequest, t: TFunction) {
  const created = pr.createdAt ? new Date(pr.createdAt) : null
  const dateText =
    created && Number.isFinite(created.getTime())
      ? getPreferAbsoluteDates()
        ? formatDate(created)
        : formatRelative(created.getTime() - Date.now())
      : null
  const subtitle = dateText
    ? `#${pr.number} ${t("pr.opened", { date: dateText, author: pr.author })}`
    : `#${pr.number} ${pr.author}`
  return pr.draft ? `${subtitle} • ${t("pr.draft")}` : subtitle
}

/** 开放的 PR / MR，分支下拉的「Pull Requests」页签。
 *
 * 结构与样式照 Desktop 的 pull-request-list.tsx / pull-request-list-item.tsx：筛选行带刷新按钮，
 * 分组头「Pull requests in owner/name」，每行图标、标题、副标题、CI 状态；点一行检出，
 * 把提交拖到一行上 cherry-pick。GitHub 与 GitLab 的字段差异在 Rust 侧统一，这里只管画。
 * CI 状态图标可点开检查项（原版的 CI 详情入口在分支按钮的徽章上，本项目放在这里）。 */
export function PullRequests({
  repo,
  remote,
  isOnDefaultBranch,
  onCherryPick,
  onCheckout,
  onCreate,
  onCreateBranch
}: {
  repo?: string
  remote: Remote | null
  isOnDefaultBranch: boolean
  onCherryPick?: (request: PullRequest, target: Remote, shas: string[]) => void
  onCheckout: (request: PullRequest, target: Remote) => void
  onCreate: () => void
  onCreateBranch: () => void
}) {
  const { t } = useTranslation()
  const { list, target, loading, error, revalidate, refresh } = usePullRequestsStore()
  // 选中仓库时已经预先取过（页签上的数量）；打开页签先显示已有的，同时重新取一次
  useEffect(() => revalidate(remote), [revalidate, remote])

  const [filterText, setFilterText] = useState("")
  // 展开哪条 PR 的检查项。一次只展开一条——同时摊开几十个 job 没人看得过来
  const [inspecting, setInspecting] = useState<{ url: string; anchor: HTMLElement } | null>(null)
  const inspectedRequest = list.find(pr => pr.url === inspecting?.url)
  const [selected, setSelected] = useState<IPullRequestListItem | null>(null)

  const groups = useMemo(
    () => [
      {
        identifier: "pull-requests",
        items: list.map(pr => ({ id: pr.url, text: [pr.title, getSubtitle(pr, t)], pullRequest: pr }))
      }
    ],
    [list, t]
  )
  const repositoryName = target ? `${target.owner}/${target.name}` : remote ? `${remote.owner}/${remote.name}` : ""

  if (loading && list.length === 0 && !error) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <>
      <SectionFilterList<IPullRequestListItem>
        // 行里有 CI 按钮：用 list/listitem，listbox 的 option 里不能再嵌可交互元素
        listRole="list"
        className="pull-request-list"
        rowHeight={RowHeight}
        groups={groups}
        selectedItem={selected}
        onSelectionChanged={setSelected}
        filterText={filterText}
        onFilterTextChanged={setFilterText}
        placeholderText={t("desktopUI.filter")}
        invalidationProps={list}
        onItemClick={item => target && onCheckout(item.pullRequest, target)}
        getItemAriaLabel={item => `#${item.pullRequest.number} ${item.pullRequest.title}`}
        getGroupAriaLabel={() => t("pr.pullRequestsIn", { repository: repositoryName })}
        renderGroupHeader={() => (
          <div className="filter-list-group-header">{t("pr.pullRequestsIn", { repository: repositoryName })}</div>
        )}
        renderPostFilter={() => (
          <Button
            variant="outline"
            size="icon-sm"
            disabled={loading || !remote}
            onClick={refresh}
            aria-label={t("pr.refreshPullRequests")}
            title={t("pr.refreshPullRequests")}>
            <SyncIcon size={16} className={loading ? "animate-spin" : undefined} />
          </Button>
        )}
        renderNoItems={() =>
          error ? (
            <div className="no-pull-requests">
              <div className="title">{t("pr.loadFailed")}</div>
              <div className="call-to-action">{error}</div>
            </div>
          ) : (
            <NoPullRequests
              isSearch={filterText.length > 0}
              isLoadingPullRequests={loading}
              repositoryName={repositoryName}
              isOnDefaultBranch={isOnDefaultBranch}
              onCreateBranch={onCreateBranch}
              onCreatePullRequest={onCreate}
            />
          )
        }
        renderItem={(item, matches) => {
          const pr = item.pullRequest
          const subtitle = getSubtitle(pr, t)
          return (
            <ContextMenu>
              <ContextMenuTrigger
                className={`pull-request-item ${pr.draft ? "draft" : "open"}`}
                onDragOver={event => {
                  if (!repo || !target || !onCherryPick || !canDropCommits(event.dataTransfer, repo)) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = "copy"
                  event.currentTarget.classList.add("drop-target")
                }}
                onDragLeave={event => event.currentTarget.classList.remove("drop-target")}
                onDrop={event => {
                  event.currentTarget.classList.remove("drop-target")
                  if (!repo || !target || !onCherryPick) return
                  const shas = takeCommitDrag(event.dataTransfer, repo)
                  if (!shas) return
                  event.preventDefault()
                  event.stopPropagation()
                  onCherryPick(pr, target, shas)
                }}>
                <div>
                  {pr.draft ? (
                    <GitPullRequestDraftIcon size={16} className="icon" />
                  ) : (
                    <GitPullRequestIcon size={16} className="icon" />
                  )}
                </div>
                <div className="info">
                  <TooltippedContent tagName="div" className="title" tooltip={pr.title} onlyWhenOverflowed={true}>
                    <HighlightText text={pr.title} highlight={matches.title} />
                  </TooltippedContent>
                  <TooltippedContent tagName="div" className="subtitle" tooltip={subtitle} onlyWhenOverflowed={true}>
                    <HighlightText text={subtitle} highlight={matches.subtitle} />
                  </TooltippedContent>
                </div>
                <div className="ci-status-container">
                  {pr.checks && pr.headSha && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("pr.checksDetail")}
                      title={t("pr.checksDetail")}
                      onClick={event => {
                        event.stopPropagation()
                        setInspecting(inspecting?.url === pr.url ? null : { url: pr.url, anchor: event.currentTarget })
                      }}>
                      <CIStatusIcon state={pr.checks} />
                    </Button>
                  )}
                </div>
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
    </>
  )
}

/** Desktop ci-status.tsx 的图标与 _ci-status.scss 的颜色：成功绿勾、失败红叉、进行中黄点、跳过/取消灰色。 */
function CIStatusIcon({ state }: { state: string }) {
  if (state === "success") return <CheckCircleFillIcon size={16} className="ci-status ci-status-success" />
  if (state === "failure" || state === "timed_out" || state === "action_required")
    return <XCircleFillIcon size={16} className="ci-status ci-status-failure" />
  if (state === "skipped" || state === "cancelled" || state === "neutral" || state === "stale")
    return <SkipIcon size={16} className="ci-status ci-status-skipped" />
  return <DotFillIcon size={16} className="ci-status ci-status-pending" />
}
