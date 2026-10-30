import { ChevronDownIcon } from "@primer/octicons-react"
import type { CSSProperties, ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/ui/base/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/base/popover"

interface Props {
  icon?: ReactNode
  /** 上面那行小字，说明这个格子是什么 */
  title: string
  /** 下面那行主文本，当前值 */
  description: string
  disabled?: boolean
  width?: number
  /** 撑满所在容器（左栏的仓库下拉用，宽度由面板决定） */
  grow?: boolean
  children?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Desktop ToolbarDropdown foldoutStyleOverrides：覆盖默认的「与按钮同宽」 */
  foldoutStyle?: CSSProperties
}

/** 工具栏下拉：`图标 | 标题 / 值 | 箭头`，点击在下方展开 foldout。
 *
 * 结构照搬 Desktop 的 ToolbarDropdown。 */
export function ToolbarDropdown({
  icon,
  title,
  description,
  disabled,
  width,
  grow,
  children,
  open,
  onOpenChange,
  foldoutStyle
}: Props) {
  const content = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col items-start">
        <span className="text-toolbar-muted truncate text-[11px] font-normal">{title}</span>
        <span className="truncate text-xs font-semibold">{description}</span>
      </span>
      {children && <ChevronDownIcon size={16} className="shrink-0" />}
    </>
  )

  const className = cn(
    grow ? "w-full flex-1" : "shrink-0",
    "border-toolbar-border h-full justify-start gap-2 rounded-none border-0 border-r px-3",
    "text-toolbar-foreground hover:bg-toolbar-hover hover:text-toolbar-foreground",
    open && "bg-toolbar-hover"
  )

  if (!children) {
    return (
      <Button variant="ghost" disabled={disabled} style={width ? { width } : undefined} className={className}>
        {content}
      </Button>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* Base UI 用 render 传自定义触发器，不是 Radix 的 asChild */}
      <PopoverTrigger
        render={
          <Button variant="ghost" disabled={disabled} style={width ? { width } : undefined} className={className} />
        }>
        {content}
      </PopoverTrigger>
      <PopoverContent
        // 弹层是 dialog，要有可访问名：用格子的标题（「当前分支」）
        aria-label={title}
        side="bottom"
        align="start"
        sideOffset={0}
        alignOffset={0}
        // 宽度跟点击框一致：Base UI 把锚元素的尺寸挂成 --anchor-width
        style={{ width: "var(--anchor-width)", ...foldoutStyle }}
        // 原版 foldout 底色就是 --background-color，和工作区同一套配色
        data-desktop-palette
        className="bg-background overflow-hidden rounded-none border-t-0 p-0">
        {children}
      </PopoverContent>
    </Popover>
  )
}
