import {
  AlertIcon,
  CheckIcon,
  DiffAddedIcon,
  DiffModifiedIcon,
  DiffRemovedIcon,
  DiffRenamedIcon
} from "@primer/octicons-react"

import { cn } from "@/lib/utils"
import type { CommitFileKind } from "@/models/history"
import type { FileChange } from "@/models/repo-status"

/** 文件状态图标。
 *
 * 图标和配色 1:1 对应原版的 `iconForStatus`（app/src/ui/octicons/status.ts）：
 *   New / Untracked → diffAdded    Modified → diffModified
 *   Deleted         → diffRemoved  Renamed  → diffRenamed
 * 用 GitHub 官方的 @primer/octicons-react，不是搬它那个 6120 行的生成文件。 */
const ICON = {
  added: { Icon: DiffAddedIcon, cls: "text-status-new" },
  modified: { Icon: DiffModifiedIcon, cls: "text-status-modified" },
  deleted: { Icon: DiffRemovedIcon, cls: "text-status-deleted" },
  renamed: { Icon: DiffRenamedIcon, cls: "text-status-renamed" },
  // 冲突：还有标记就是感叹号，改干净了就是勾（原版 iconForStatus 的分支）
  conflicted: { Icon: AlertIcon, cls: "text-status-conflicted" },
  resolved: { Icon: CheckIcon, cls: "text-status-new" }
} as const

type Kind = keyof typeof ICON

export function StatusIcon({ kind }: { kind: Kind }) {
  const { Icon, cls } = ICON[kind]
  return <Icon size={16} aria-label={kind} className={cn("shrink-0", cls)} />
}

export function ChangeStatusIcon({ file }: { file: FileChange }) {
  if (file.change === "conflicted") {
    // 二进制文件没有标记可数，0 不等于已解决——不能画成勾
    const c = file.conflict
    const clean = c !== null && !c.binary && c.markers === 0
    return <StatusIcon kind={clean ? "resolved" : "conflicted"} />
  }
  // 复制出来的和新增的一样是「多了个文件」，原版 iconForStatus 也是同一个图标
  return <StatusIcon kind={file.change === "copied" ? "added" : file.change} />
}

export function CommitStatusIcon({ kind }: { kind: CommitFileKind }) {
  return <StatusIcon kind={kind === "copied" ? "added" : kind} />
}
