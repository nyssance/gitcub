import { AlertIcon, CheckIcon, XIcon } from "@primer/octicons-react"
import { useEffect } from "react"

import { cn } from "@/lib/utils"
import { Button, Button as StandardButton } from "@/ui/base/button"

/** 刚做完一件事的提示条，带一个「撤销」。
 *
 * 做完之后什么都不说，用户只能靠列表变空来猜；而像提交这种一步之遥就能收回的
 * 动作，收回的入口藏在菜单里等于没有。原版在改动列表顶上挂的就是这么一条。
 *
 * 会自己消失：留着不动的话，十分钟前那句「已提交」还杵在那儿，比没有更糟。 */
export function Banner({
  message,
  actionLabel,
  onAction,
  onDismiss,
  /** 提醒类的（比如「这个仓库要装 LFS」）不能自己溜走：问题没解决之前
   *  它得一直杵在那儿 */
  sticky,
  warning
}: {
  message: string
  actionLabel?: string
  onAction?: () => void
  onDismiss: () => void
  sticky?: boolean
  warning?: boolean
}) {
  // message 变化必须重新开始这条提示的倒计时。
  useEffect(() => {
    if (sticky) return
    const timer = window.setTimeout(onDismiss, 15000)
    return () => window.clearTimeout(timer)
    // message 变了就重新计时——新的一条该有自己的完整时间
  }, [message, sticky, onDismiss])

  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs",
        warning ? "bg-destructive/10 text-foreground" : "bg-muted/60"
      )}>
      {warning ? (
        <AlertIcon size={14} className="text-destructive shrink-0" />
      ) : (
        <CheckIcon size={14} className="text-status-new shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {actionLabel && onAction && (
        <Button size="sm" variant="ghost" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      <StandardButton variant="ghost" type="button" onClick={onDismiss} aria-label="dismiss" className="shrink-0">
        <XIcon size={12} />
      </StandardButton>
    </div>
  )
}
