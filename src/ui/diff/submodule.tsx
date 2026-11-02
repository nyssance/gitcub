import { FileSubmoduleIcon, GitCommitIcon, InfoIcon, PencilIcon } from "@primer/octicons-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { ipc } from "@/lib/ipc"
import type { SubmoduleInfo } from "@/models/app-state"
import type { FileChange } from "@/models/repo-status"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/** 子模块的「diff」。
 *
 * 子模块在父仓库眼里只是一条「指向某个提交」的记录，拿它去做文本对比没有
 * 意义（会把一个目录当文件读）。原版专门画了一块 SubmoduleDiff，这里是同一
 * 个意思的精简版：它是哪个仓库、指向的提交动没动、里面还剩多少没提交的东西。
 *
 * 最后那条最要紧：子模块内部的改动**提交不进父仓库**，不说清楚的话用户会
 * 以为自己已经把它们提交了。 */
export function SubmoduleView({
  repo,
  file,
  onOpen
}: {
  repo: string
  file: FileChange
  /** 把子模块当成一个仓库打开 */
  onOpen: (path: string) => void
}) {
  const { t } = useTranslation()
  const [info, setInfo] = useState<SubmoduleInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setInfo(null)
    setError(null)
    ipc
      .submoduleInfo(repo, file.path)
      .then(value => active && setInfo(value))
      .catch((e: unknown) => active && setError(String(e)))
    return () => {
      active = false
    }
  }, [repo, file.path])

  if (error) {
    return <div className="text-destructive p-4 text-xs">{error}</div>
  }
  if (!info) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  const short = (sha: string | null) => sha?.slice(0, 7) ?? "—"
  const moved = info.recorded !== info.actual

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-xs">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <FileSubmoduleIcon size={16} />
        {file.path}
      </div>

      {info.url && <Line icon={<InfoIcon size={14} />}>{t("submodule.from", { url: info.url })}</Line>}

      <Line icon={<GitCommitIcon size={14} />}>
        {moved
          ? t("submodule.moved", { from: short(info.recorded), to: short(info.actual) })
          : t("submodule.same", { sha: short(info.actual) })}
      </Line>

      {info.dirty > 0 && <Line icon={<PencilIcon size={14} />}>{t("submodule.dirty", { count: info.dirty })}</Line>}

      <div>
        <Button size="sm" variant="outline" onClick={() => onOpen(info.fullPath)}>
          {t("submodule.open")}
        </Button>
      </div>
    </div>
  )
}

function Line({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  )
}
