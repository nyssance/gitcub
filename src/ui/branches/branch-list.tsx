// Desktop MIT port: app/src/ui/branches/branch-list.tsx, written as a function component (AGENTS.md React style).

import type * as React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type { SelectionSource } from "../../lib/filter-list"
import { formatDate } from "../../lib/format-date"
import { getAuthors } from "../../lib/git/authors"
import { type BranchGroupIdentifier, groupBranches, type IBranchListItem } from "../../lib/group-branches"
import { type IMenuItem, showContextualMenu } from "../../lib/menu/menu-item"
import type { Branch } from "../../models/branch"
import type { Repository } from "../../models/repository"
import type { IMatches } from "../../upstream/lib/fuzzy-find"
import { Button } from "../desktop/button"
import type { ClickSource } from "../desktop/list/section-list"
import { SectionFilterList } from "../desktop/section-filter-list"
import { generateBranchContextMenuItems } from "./branch-list-item-context-menu"
import { NoBranches } from "./no-branches"

const RowHeight = 30

interface IBranchListProps {
  readonly repository: Repository
  /** See IBranchesState.defaultBranch */
  readonly defaultBranch: Branch | null
  /** The currently checked out branch or null if HEAD is detached */
  readonly currentBranch: Branch | null
  /** See IBranchesState.allBranches */
  readonly allBranches: ReadonlyArray<Branch>
  /** See IBranchesState.recentBranches */
  readonly recentBranches: ReadonlyArray<Branch>
  /** The currently selected branch in the list, see the onSelectionChanged prop. */
  readonly selectedBranch: Branch | null
  readonly onFilterKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
  /** Called when an item is clicked. */
  readonly onItemClick?: (item: Branch, source: ClickSource) => void
  readonly onSelectionChanged?: (selectedItem: Branch | null, source: SelectionSource) => void
  /** The current filter text to render */
  readonly filterText: string
  /** Callback to fire when the filter text is changed */
  readonly onFilterTextChanged: (filterText: string) => void
  /** Can users create a new branch? */
  readonly canCreateNewBranch: boolean
  /** Called when the user wants to create a new branch, given a name to prepopulate. */
  readonly onCreateNewBranch?: (name: string) => void
  /** Aria label for a specific row */
  readonly getBranchAriaLabel: (item: IBranchListItem, authorDate: Date | undefined) => string | undefined
  /** Render function to apply to each branch in the list */
  readonly renderBranch: (item: IBranchListItem, matches: IMatches, authorDate: Date | undefined) => React.JSX.Element
  readonly onFilterListResultsChanged?: (resultCount: number) => void
  /** If true, we do not render the filter. */
  readonly hideFilterRow?: boolean
  /** Called to render content before/above the branches filter and list. */
  readonly renderPreList?: () => React.JSX.Element | null
  /** Optional: No branches message */
  readonly noBranchesMessage?: string | React.JSX.Element
  /** Optional: Callback for if rename context menu should exist */
  readonly onRenameBranch?: (branchName: string) => void
  /** Optional: Callback for if delete context menu should exist */
  readonly onDeleteBranch?: (branchName: string) => void
  /** Optional: Callback to checkout a branch in a new worktree */
  readonly onCheckoutInNewWorktree?: (branch: Branch) => void
  /** GitCub: merge / squash / rebase entries kept at the top of the branch context menu. */
  readonly extraContextMenuItems?: (branch: Branch) => ReadonlyArray<IMenuItem>
}

const commitDateCache = new Map<string, Date>()

/** The Branches list component. */
export function BranchList(props: IBranchListProps) {
  const { t } = useTranslation()
  const { repository, allBranches, defaultBranch, currentBranch, recentBranches, selectedBranch } = props
  const [commitAuthorDates, setCommitAuthorDates] = useState<ReadonlyMap<string, Date>>(new Map())

  const groups = useMemo(
    () => groupBranches(defaultBranch, currentBranch, allBranches, recentBranches),
    [defaultBranch, currentBranch, allBranches, recentBranches]
  )
  const selectedItem = useMemo(
    () => groups.flatMap(g => g.items).find(i => i.branch.name === selectedBranch?.name) ?? null,
    [groups, selectedBranch]
  )
  // Desktop getInvalidationProp：分组或日期变了就换一个新对象，让列表重画
  const invalidationProps = useMemo(() => ({ groups, commitAuthorDates }), [groups, commitAuthorDates])

  // Desktop populateCommitDates：缓存命中的先显示，缺的用 git log 一次补齐
  // 只随路径和分支列表重读：上层每次渲染都可能给一个新的 Repository 对象
  const repositoryRef = useRef(repository)
  repositoryRef.current = repository
  useEffect(() => {
    let active = true
    const populate = () => {
      const cached = new Map<string, Date>()
      const missing = new Array<string>()
      const uniqShas = new Set(allBranches.map(b => b.tip.sha))
      for (const sha of uniqShas) {
        const date = commitDateCache.get(sha)
        if (date) cached.set(sha, date)
        else missing.push(sha)
      }
      for (const sha of commitDateCache.keys()) {
        if (!uniqShas.has(sha)) commitDateCache.delete(sha)
      }
      if (active) setCommitAuthorDates(cached)
      return missing
    }
    const missing = populate()
    if (missing.length > 0) {
      getAuthors(repositoryRef.current, missing)
        .then(authors => {
          authors.forEach(({ date }, i) => commitDateCache.set(missing[i], date))
          populate()
        })
        .catch(e => log.error(`Failed to populate commit dates`, e))
    }
    return () => {
      active = false
    }
  }, [repository.path, allBranches])

  const getGroupLabel = useCallback(
    (identifier: BranchGroupIdentifier) =>
      identifier === "default"
        ? t("desktopUI.defaultBranch")
        : identifier === "recent"
          ? t("desktopUI.recentBranches")
          : t("desktopUI.otherBranches"),
    [t]
  )

  const { onRenameBranch, onDeleteBranch, onCheckoutInNewWorktree, extraContextMenuItems } = props
  const onBranchContextMenu = (item: IBranchListItem, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (
      onRenameBranch === undefined &&
      onDeleteBranch === undefined &&
      onCheckoutInNewWorktree === undefined &&
      extraContextMenuItems === undefined
    ) {
      return
    }
    const { branch } = item
    const extra = extraContextMenuItems?.(branch) ?? []
    void showContextualMenu([
      ...extra,
      ...(extra.length > 0 ? [{ type: "separator" as const }] : []),
      ...generateBranchContextMenuItems({ branch, onRenameBranch, onDeleteBranch, onCheckoutInNewWorktree })
    ])
  }

  const onCreateNewBranch = () => props.onCreateNewBranch?.(props.filterText)

  return (
    <SectionFilterList<IBranchListItem>
      className="branches-list"
      rowHeight={RowHeight}
      placeholderText={t("desktopUI.filter")}
      filterText={props.filterText}
      onFilterTextChanged={props.onFilterTextChanged}
      onFilterKeyDown={props.onFilterKeyDown}
      selectedItem={selectedItem}
      renderItem={(item, matches) => props.renderBranch(item, matches, commitAuthorDates.get(item.branch.tip.sha))}
      renderRowFocusTooltip={item => {
        const authorDate = commitAuthorDates.get(item.branch.tip.sha)
        const absoluteDate = authorDate ? formatDate(authorDate, { dateStyle: "full", timeStyle: "short" }) : null
        return (
          <div className="branches-list-item-tooltip list-item-tooltip">
            <div>
              <div className="label">{t("desktopUI.fullName")}</div>
              {item.branch.name}
            </div>
            {absoluteDate && (
              <div>
                <div className="label">{t("desktopUI.lastModified")}</div>
                {absoluteDate}
              </div>
            )}
          </div>
        )
      }}
      renderGroupHeader={label =>
        label === "default" || label === "recent" || label === "other" ? (
          <div className="branches-list-content filter-list-group-header">{getGroupLabel(label)}</div>
        ) : null
      }
      onItemClick={(item, source) => props.onItemClick?.(item.branch, source)}
      onSelectionChanged={(item, source) => props.onSelectionChanged?.(item ? item.branch : null, source)}
      onEnterPressedWithoutFilteredItems={onCreateNewBranch}
      groups={groups}
      invalidationProps={invalidationProps}
      renderPostFilter={() =>
        props.canCreateNewBranch ? (
          <Button className="new-branch-button" onClick={onCreateNewBranch}>
            {t("desktopUI.newBranch")}
          </Button>
        ) : null
      }
      renderNoItems={() => (
        <NoBranches
          onCreateNewBranch={onCreateNewBranch}
          canCreateNewBranch={props.canCreateNewBranch}
          noBranchesMessage={props.noBranchesMessage}
        />
      )}
      hideFilterRow={props.hideFilterRow}
      onFilterListResultsChanged={props.onFilterListResultsChanged}
      renderPreList={props.renderPreList}
      onItemContextMenu={onBranchContextMenu}
      getItemAriaLabel={item => props.getBranchAriaLabel(item, commitAuthorDates.get(item.branch.tip.sha))}
      getGroupAriaLabel={group => getGroupLabel(groups[group].identifier as BranchGroupIdentifier)}
    />
  )
}
