import { cn } from "@/lib/utils"

/** 文件路径：目录部分淡化，文件名正常——一屏几十行时眼睛只找文件名。
 *
 * 对应 Desktop 的 PathText（`.path-text-component` 省略号 + `.dirname` 次级色）。
 * 选中行里 Desktop 把 --text-secondary-color 换成选中态的正文色（_list.scss），
 * 这里由 `.desktop-list-row[data-selected]` 覆盖 --muted-foreground 达到同样效果。 */
export function Path({ path, className }: { path: string; className?: string }) {
  const cut = path.lastIndexOf("/") + 1
  return (
    <span className={cn("min-w-0 truncate", className)} title={path}>
      {cut > 0 && <span className="text-muted-foreground">{path.slice(0, cut)}</span>}
      {path.slice(cut)}
    </span>
  )
}
