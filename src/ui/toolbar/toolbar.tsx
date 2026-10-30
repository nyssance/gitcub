import type { RepoStatus } from "@/models/repo-status"

import { BranchDropdown } from "./branch-dropdown"
import { PushPullButton } from "./push-pull-button"

/** 工具栏。只属于右列——左栏是常驻的仓库列表，通栏从上到下，
 * 所以「当前仓库」那格没了（Desktop 把它做成下拉，是因为它没有常驻列表）。
 * 整条是拖拽区：macOS 上红绿灯浮在左栏顶部，这里不用让位。 */

export function ToolbarRight(props: {
  repo: string | null
  status: RepoStatus
  busy: boolean
  progress?: string
  onCheckout: (branch: string) => Promise<void>
  onCreateBranch: (name: string, startPoint?: string, noTrack?: boolean) => Promise<void>
  onDeleteBranch: (name: string) => Promise<void>
  onMergeBranch: (name: string, squash: boolean) => Promise<void>
  onRebaseBranch: (name: string) => Promise<void>
  onRenameBranch: (from: string) => void
  onPush: () => void
  onPull: () => void
  onFetch: () => void
  onPublish: () => void
  onWorktrees: () => void
  onOpenWorktree: (path: string) => void
}) {
  return (
    <div className="bg-toolbar flex h-[50px] shrink-0 items-stretch" data-tauri-drag-region>
      <BranchDropdown
        repo={props.busy ? null : props.repo}
        branch={props.status.branch}
        onCheckout={props.onCheckout}
        onCreate={props.onCreateBranch}
        onDelete={props.onDeleteBranch}
        onMerge={props.onMergeBranch}
        onRebase={props.onRebaseBranch}
        onRename={props.onRenameBranch}
        onWorktrees={props.onWorktrees}
        onOpenWorktree={props.onOpenWorktree}
      />
      <PushPullButton
        status={props.status}
        disabled={!props.repo}
        busy={props.busy}
        progress={props.progress}
        onPush={props.onPush}
        onPull={props.onPull}
        onFetch={props.onFetch}
        onPublish={props.onPublish}
      />
    </div>
  )
}
