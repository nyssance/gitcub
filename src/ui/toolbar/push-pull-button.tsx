import { ArrowDownIcon, ArrowUpIcon, SyncIcon, UploadIcon } from "@primer/octicons-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import type { RepoStatus } from "@/models/repo-status"
import { Button as StandardButton } from "@/ui/base/button"

interface Props {
  status: RepoStatus
  disabled: boolean
  busy: boolean
  progress?: string
  onPush: () => void
  onPull: () => void
  onFetch: () => void
  /** 还没有远端时，这一格是「发布仓库」 */
  onPublish: () => void
}

/** 上下文感知的推送按钮。
 *
 * 对齐 Desktop 的 push-pull-button：同一个格子按仓库状态切换含义——
 * 未设上游→发布分支，落后→拉取 ↓N，领先→推送 ↑N，都同步→拉取更新。 */
export function PushPullButton({ status, disabled, busy, progress, onPush, onPull, onFetch, onPublish }: Props) {
  const { t } = useTranslation()
  const { hasUpstream, ahead, behind } = status

  const state = !hasUpstream
    ? ("publish" as const)
    : behind > 0
      ? ("pull" as const)
      : ahead > 0
        ? ("push" as const)
        : ("fetch" as const)

  const config = {
    // 没有远端时「推送」无处可推——这一格该做的是先把仓库发布出去
    publish: { icon: UploadIcon, title: t("toolbar.publishBranch"), desc: t("toolbar.publishHint"), on: onPublish },
    pull: {
      icon: ArrowDownIcon,
      title: t("toolbar.pull", { remote: status.remote ?? "origin" }),
      desc: t("toolbar.behindBy", { count: behind }),
      on: onPull
    },
    push: {
      icon: ArrowUpIcon,
      title: t("toolbar.push", { remote: status.remote ?? "origin" }),
      desc: t("toolbar.aheadBy", { count: ahead }),
      on: onPush
    },
    fetch: {
      icon: SyncIcon,
      title: t("toolbar.fetch", { remote: status.remote ?? "origin" }),
      desc: t("toolbar.upToDate"),
      on: onFetch
    }
  }[state]

  const Icon = config.icon

  return (
    <StandardButton
      variant="ghost"
      type="button"
      disabled={disabled || busy}
      onClick={config.on}
      className={cn(
        // 原版 app-store defaultPushPullButtonWidth：230px，不撑满工具栏
        "border-toolbar-border flex h-full w-[230px] min-w-0 shrink-0 items-center gap-2 border-r px-3 text-left",
        "text-toolbar-foreground hover:bg-toolbar-hover disabled:opacity-50"
      )}>
      <Icon size={16} className={cn("shrink-0", busy && "animate-spin")} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-toolbar-muted truncate text-[11px]">{config.title}</span>
        <span className="truncate text-xs font-semibold">{busy && progress ? progress : config.desc}</span>
      </span>
      {(ahead > 0 || behind > 0) && hasUpstream && (
        <span className="flex shrink-0 items-center gap-1 text-[11px]">
          {behind > 0 && (
            <span className="flex items-center">
              <ArrowDownIcon size={12} />
              {behind}
            </span>
          )}
          {ahead > 0 && (
            <span className="flex items-center">
              <ArrowUpIcon size={12} />
              {ahead}
            </span>
          )}
        </span>
      )}
    </StandardButton>
  )
}
