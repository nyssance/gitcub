import { AlertIcon, CheckIcon } from "@primer/octicons-react"
import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import type { Resolution } from "@/models/app-state"
import type { FileChange, Operation } from "@/models/repo-status"
import { Button } from "@/ui/base/button"

/** 一个取舍按钮上该写什么。
 *
 * 一边改、一边删的冲突里，被删的那边**根本没有版本可取**——按钮还写「用 X 的」
 * 就是骗人（点下去实际是删掉文件）。照原版 getLabelForManualResolutionOption
 * 的口径：那边有版本就是「用 X 的」，没有就是「不要这个文件」。 */
function label(t: TFunction, exists: boolean, branch: string) {
  return exists ? t("conflicts.keep", { branch }) : t("conflicts.drop", { branch })
}

/** 「操作进行中」横幅 + 逐文件取舍。
 *
 * 只要合并/变基/摘取/回滚还没收尾就一直在——冲突全解决了也还得显式地
 * 继续或中止，横幅这时候消失的话，用户就卡在半路上没有任何出口了。
 * 原版的做法是同一套：列出冲突文件，每个给「用我们的 / 用他们的」，
 * 全部解决后才允许继续（提交合并 / 继续变基）。
 *
 * 「我们的」是当前分支那一版，「他们的」是被合并进来那一版——这两个词
 * 单独看很容易搞反，所以界面上直接写清楚是哪条分支。 */
export function Conflicts({
  operation,
  busy = false,
  files,
  ours,
  theirs,
  onResolve,
  onAbort,
  onContinue
}: {
  /** 正在进行的操作。null = 没有，横幅不出现 */
  operation: Operation | null
  busy?: boolean
  /** 还没解决的冲突文件 */
  files: FileChange[]
  /** 当前分支名 */
  ours: string | null
  /** 正在被合并进来的那条分支；变基时是目标分支 */
  theirs: string | null
  onResolve: (file: FileChange, keep: Resolution) => void
  onAbort: (operation: Operation) => void
  onContinue: (operation: Operation) => void
}) {
  const { t } = useTranslation()
  if (!operation) return null
  const done = files.length === 0

  return (
    <div className={cn("shrink-0 border-b", done ? "bg-muted/40" : "border-destructive/30 bg-destructive/5")}>
      <div
        className={cn(
          "flex h-8 items-center gap-1.5 px-3 text-xs font-semibold",
          done ? "text-muted-foreground" : "text-foreground"
        )}>
        {done ? <CheckIcon size={14} /> : <AlertIcon size={14} className="text-destructive" />}
        {done
          ? t(`conflicts.resolved.${operation}`, { branch: theirs ?? "" })
          : t("conflicts.title", { count: files.length })}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAbort(operation)}>
          {t("conflicts.abort")}
        </Button>
        {/* 还有没解决的文件时 git 一定会拒绝，按钮就不该是可按的 */}
        <Button size="sm" disabled={busy || !done} onClick={() => onContinue(operation)}>
          {t(`conflicts.continue.${operation}`)}
        </Button>
      </div>

      {files.map(f => (
        <div key={f.path} className="flex h-8 items-center gap-2 px-3">
          <span className="min-w-0 flex-1 truncate text-xs" title={f.path}>
            {f.path}
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve(f, "ours")}>
            {label(
              t,
              f.conflict?.hasOurs !== false,
              operation === "rebase" ? t("conflicts.rebaseBase") : (ours ?? t("conflicts.here"))
            )}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve(f, "theirs")}>
            {label(
              t,
              f.conflict?.hasTheirs !== false,
              operation === "rebase" ? t("conflicts.rebaseCommit") : (theirs ?? t("conflicts.incoming"))
            )}
          </Button>
        </div>
      ))}
    </div>
  )
}
