// Desktop MIT port: app/src/ui/branches/branch-list-item-context-menu.tsx; labels go through i18n.
import i18n from "../../lib/i18n"
import type { IMenuItem } from "../../lib/menu/menu-item"
import { type Branch, BranchType } from "../../models/branch"
import { writeClipboardText } from "../desktop-window-proxy"

interface IBranchContextMenuConfig {
  branch: Branch
  onRenameBranch?: (branchName: string) => void
  onViewBranchOnGitHub?: () => void
  onViewPullRequestOnGitHub?: () => void
  onDeleteBranch?: (branchName: string) => void
  onCheckoutInNewWorktree?: (branch: Branch) => void
}

export function generateBranchContextMenuItems(config: IBranchContextMenuConfig): IMenuItem[] {
  const {
    branch,
    onRenameBranch,
    onViewBranchOnGitHub,
    onViewPullRequestOnGitHub,
    onDeleteBranch,
    onCheckoutInNewWorktree
  } = config
  const items = new Array<IMenuItem>()

  if (onRenameBranch !== undefined) {
    items.push({
      label: i18n.t("desktopUI.renameEllipsis"),
      action: () => onRenameBranch(branch.name),
      enabled: branch.type === BranchType.Local
    })
  }

  items.push({
    label: i18n.t("desktopUI.copyBranchName"),
    action: () => writeClipboardText(branch.name)
  })

  if (onViewBranchOnGitHub !== undefined) {
    items.push({
      label: "View Branch on GitHub",
      action: () => onViewBranchOnGitHub()
    })
  }

  if (onViewPullRequestOnGitHub !== undefined) {
    items.push({
      label: "View Pull Request on GitHub",
      action: () => onViewPullRequestOnGitHub()
    })
  }

  if (onCheckoutInNewWorktree !== undefined) {
    items.push({
      label: i18n.t("desktopUI.checkoutInNewWorktree"),
      action: () => onCheckoutInNewWorktree(branch)
    })
  }

  items.push({ type: "separator" })

  if (onDeleteBranch !== undefined) {
    items.push({
      label: i18n.t("desktopUI.deleteEllipsis"),
      action: () => onDeleteBranch(branch.name)
    })
  }

  return items
}
