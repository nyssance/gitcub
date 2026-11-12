import { type ReactNode, useState } from "react"
import { useTranslation } from "react-i18next"

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import type { HostingPlatform } from "@/lib/autolink-rules"
import { changesetLineCounts } from "@/lib/commit-line-counts"
import type { AutolinkRule, Remote } from "@/models/app-state"
import type { Commit } from "@/models/commit"
import type { CommitFile, CommitInfo } from "@/models/history"

import { CommitSummary } from "./commit-summary"
import { ExpandableCommitSummary } from "./expandable-commit-summary"
import { CommitFileList } from "./file-list"

export function CommitDetails({
  commit,
  details,
  remote,
  platform,
  autolinks,
  files,
  selected,
  onSelect,
  onShowHistory,
  range,
  children
}: {
  commit: CommitInfo
  /** 选中提交的完整信息；加载出来前先用列表里的 CommitInfo 显示 */
  details: Commit | null
  remote: Remote | null
  platform?: HostingPlatform
  autolinks?: ReadonlyArray<AutolinkRule>
  files: CommitFile[]
  selected: string | null
  onSelect: (path: string) => void
  onShowHistory?: (path: string) => void
  /** 多选连续提交：选了几个、其中几个的改动在这份 diff 里（Desktop shasInDiff） */
  range?: { selected: number; inDiff: number }
  children: ReactNode
}) {
  const { t } = useTranslation()
  // Desktop SelectedCommits：切换提交时收起
  const [expandedSha, setExpandedSha] = useState<string | null>(null)
  const { linesAdded, linesDeleted } = changesetLineCounts(files)
  return (
    <>
      {range ? (
        // Desktop ExpandableCommitSummary 多个提交时：标题换成「Showing changes from N commits」，
        // 不显示某一个提交的 SHA、正文与标签；合并带进来、不在这份 diff 里的提交单独说明
        <div id="expandable-commit-summary" data-multiple-commits>
          <div className="ecs-title">
            <span className="selectable">{t("history.showingChangesFromCommits", { count: range.inDiff })}</span>
          </div>
          {range.selected > range.inDiff && (
            <div className="commit-unreachable-info text-muted-foreground px-3 pb-2 text-xs">
              {t("history.unreachableCommitsNotIncluded", { count: range.selected - range.inDiff })}
            </div>
          )}
        </div>
      ) : details?.sha === commit.sha ? (
        <ExpandableCommitSummary
          commit={details}
          linesAdded={linesAdded}
          linesDeleted={linesDeleted}
          isExpanded={expandedSha === commit.sha}
          onExpandChanged={expanded => setExpandedSha(expanded ? commit.sha : null)}
          remote={remote}
          platform={platform}
          rules={autolinks}
        />
      ) : (
        <CommitSummary commit={commit} remote={remote} platform={platform} rules={autolinks} files={files} />
      )}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" data-commit-details>
        <ResizablePanel defaultSize={200} minSize="25%" maxSize="40%">
          <CommitFileList files={files} selected={selected} onSelect={onSelect} onShowHistory={onShowHistory} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize="60%">
          <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">{children}</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  )
}

/** Desktop SelectedCommits renderMultipleCommitsBlankSlate：多选的提交不连续时没有可显示的 diff */
export function MultipleCommitsSelected() {
  const { t } = useTranslation()
  return (
    <div
      id="multiple-commits-selected"
      className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm">
      <p className="text-foreground">{t("history.unableToDisplayDiffWhenMultipleNonConsecutiveCommitsAreSelected")}</p>
      <div>{t("history.youCan")}</div>
      <ul className="list-disc pl-5">
        <li>{t("history.selectASingleCommitOrARangeOfConsecutiveCommitsToViewADiff")}</li>
        <li>{t("history.dragTheCommitsToTheBranchMenuToCherryPickThem")}</li>
        <li>{t("history.dragTheCommitsToSquashOrReorderThem")}</li>
        <li>{t("history.rightClickOnMultipleCommitsToSeeOptions")}</li>
      </ul>
    </div>
  )
}
