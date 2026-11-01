import { type ReactNode, useState } from "react"

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
  children: ReactNode
}) {
  // Desktop SelectedCommits：切换提交时收起
  const [expandedSha, setExpandedSha] = useState<string | null>(null)
  const { linesAdded, linesDeleted } = changesetLineCounts(files)
  return (
    <>
      {details?.sha === commit.sha ? (
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
