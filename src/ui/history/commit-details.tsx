import type { ReactNode } from "react"

import type { HostingPlatform } from "@/lib/autolink-rules"
import type { AutolinkRule, Remote } from "@/models/app-state"
import type { CommitFile, CommitInfo } from "@/models/history"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"

import { CommitSummary } from "./commit-summary"
import { CommitFileList } from "./file-list"

export function CommitDetails({
  commit,
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
  remote: Remote | null
  platform?: HostingPlatform
  autolinks?: ReadonlyArray<AutolinkRule>
  files: CommitFile[]
  selected: string | null
  onSelect: (path: string) => void
  onShowHistory?: (path: string) => void
  children: ReactNode
}) {
  return (
    <>
      <CommitSummary commit={commit} remote={remote} platform={platform} rules={autolinks} files={files} />
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
