import { ArchiveIcon, TrashIcon } from "@primer/octicons-react"
import { useTranslation } from "react-i18next"

import type { StashEntry } from "@/models/app-state"
import { Button, Button as StandardButton } from "@/ui/base/button"

/** 贮藏列表。
 *
 * 只在有贮藏时才出现：没有贮藏的时候摆一条「暂无贮藏」是纯噪音。
 * 消息里带标记的是本客户端建的，其余是用户手工 `git stash` 的——都列出来，
 * 只是标记一下来源，不做区别对待。 */
export function Stashes({
  stashes,
  onPop,
  onDrop
}: {
  stashes: StashEntry[]
  onPop: (name: string) => void
  onDrop: (name: string) => void
}) {
  const { t } = useTranslation()
  if (stashes.length === 0) return null

  return (
    <div className="shrink-0 border-b">
      <div className="text-muted-foreground flex h-7 items-center gap-1.5 px-3 text-[11px] font-semibold">
        <ArchiveIcon size={12} />
        {t("stash.title")}
        <span className="ml-auto font-normal">{stashes.length}</span>
      </div>
      {stashes.map(s => (
        <div key={s.name} className="group/stash hover:bg-accent/50 flex h-8 items-center gap-2 px-3">
          <span className="min-w-0 flex-1 truncate text-xs" title={s.message}>
            {/* 本客户端建的贮藏消息是 `!!GitCub<分支>`，直接显示不好看，
                换成分支名；手工建的就原样显示 */}
            {s.ours ? s.message.replace(/^.*<(.*)>$/, "$1") : s.message}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="opacity-0 group-hover/stash:opacity-100"
            onClick={() => onPop(s.name)}>
            {t("stash.pop")}
          </Button>
          <StandardButton
            variant="ghost"
            type="button"
            title={t("stash.drop")}
            onClick={() => onDrop(s.name)}
            className="text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover/stash:opacity-100">
            <TrashIcon size={14} />
          </StandardButton>
        </div>
      ))}
    </div>
  )
}
