import { XIcon } from "@primer/octicons-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { ipc } from "@/lib/ipc"
import { cn } from "@/lib/utils"
import type { BlameLine } from "@/models/history"
import { Button, Button as StandardButton } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/** 逐行追溯。
 *
 * 左边一列是「这行最后被谁在哪次提交改的」。同一个提交的连续行只在第一行
 * 显示信息——整屏重复同一个名字没有信息量，反而把代码挤没了。 */
export function Blame({
  repo,
  file,
  onClose,
  onSelectCommit
}: {
  repo: string
  file: string
  onClose: () => void
  onSelectCommit: (sha: string) => void
}) {
  const { t } = useTranslation()
  const [lines, setLines] = useState<BlameLine[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 36,
    overscan: 8
  })
  const visibleRows = virtualizer.getVirtualItems()

  useEffect(() => {
    let active = true
    setLines([])
    viewport.current?.scrollTo({ top: 0, left: 0 })
    setBusy(true)
    setError(null)
    ipc
      .blame(repo, file)
      .then(value => active && setLines(value))
      .catch((e: unknown) => active && setError(String(e)))
      .finally(() => active && setBusy(false))
    return () => {
      active = false
    }
  }, [repo, file])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="shrink-0 text-xs font-semibold">{t("blame.title")}</span>
        <span className="text-muted-foreground truncate text-xs">{file}</span>
        <div className="flex-1" />
        <Button size="icon-sm" variant="ghost" onClick={onClose} title={t("common.close")}>
          <XIcon size={14} />
        </Button>
      </div>

      {error && (
        <div role="alert" className="text-foreground bg-destructive/10 shrink-0 px-3 py-1.5 text-[11px]">
          {error}
        </div>
      )}

      <div
        ref={viewport}
        role="region"
        aria-label={t("blame.title")}
        className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-5">
        {busy ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <div className="relative min-w-full" style={{ height: virtualizer.getTotalSize() }}>
            {visibleRows.map(row => {
              const i = row.index
              const l = lines[i]
              const first = i === Math.floor((virtualizer.scrollOffset ?? 0) / 36) || lines[i - 1]?.sha !== l.sha
              return (
                <div
                  key={`${l.sha}-${l.line}`}
                  className="hover:bg-accent/40 absolute top-0 left-0 flex w-max min-w-full items-center"
                  style={{ height: row.size, transform: `translateY(${row.start}px)` }}>
                  <StandardButton
                    variant="ghost"
                    type="button"
                    onClick={() => onSelectCommit(l.sha)}
                    title={`${l.summary}\n${l.author}`}
                    className={cn(
                      "text-muted-foreground w-52 shrink-0 truncate border-r px-2 text-left",
                      first ? "hover:text-foreground hover:underline" : "opacity-0"
                    )}>
                    {l.shortSha} {l.author}
                  </StandardButton>
                  <span className="text-muted-foreground w-12 shrink-0 border-r px-2 text-right">{l.line}</span>
                  <span className="px-3 whitespace-pre">{l.content}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
