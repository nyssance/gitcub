// Desktop MIT port; platform imports adapted to Tauri.
import i18n from "../../lib/i18n"
import type { IMenuItem } from "../../lib/menu/menu-item"
import * as Path from "../../lib/platform-path"
import { writeClipboardText } from "../desktop-window-proxy"

interface IWorktreeContextMenuConfig {
  readonly path: string
  readonly isMainWorktree: boolean
  readonly isLocked: boolean
  readonly onRenameWorktree?: (path: string) => void
  readonly onRemoveWorktree?: (path: string) => void
}

export function generateWorktreeContextMenuItems(config: IWorktreeContextMenuConfig): ReadonlyArray<IMenuItem> {
  const { path, isMainWorktree, isLocked, onRenameWorktree, onRemoveWorktree } = config
  const name = Path.basename(path)
  const items = new Array<IMenuItem>()

  if (onRenameWorktree !== undefined) {
    items.push({
      label: i18n.t("desktopUI.renameEllipsis"),
      action: () => onRenameWorktree(path),
      enabled: !isMainWorktree && !isLocked
    })
  }

  items.push({
    label: i18n.t("desktopUI.copyWorktreeName"),
    action: () => writeClipboardText(name)
  })

  items.push({
    label: i18n.t("desktopUI.copyWorktreePath"),
    action: () => writeClipboardText(path)
  })

  items.push({ type: "separator" })

  if (onRemoveWorktree !== undefined) {
    items.push({
      label: i18n.t("desktopUI.deleteEllipsis"),
      action: () => onRemoveWorktree(path),
      enabled: !isMainWorktree && !isLocked
    })
  }

  return items
}
