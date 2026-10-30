import { AlertIcon, FilterIcon } from "@primer/octicons-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { applyFilters, hasActiveFilters, isCommittingFileHiddenByFilter } from "@/lib/desktop-filter-changes"
import { appStatus } from "@/lib/desktop-status"
import type { CommitOptions, Issue } from "@/models/app-state"
import { emptyChangesFilter, type IChangesListItem } from "@/models/changes-filter"
import type { FileChange } from "@/models/repo-status"
import { Button } from "@/ui/base/button"
import { Checkbox } from "@/ui/base/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/ui/base/dropdown-menu"
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/base/empty"
import { Input } from "@/ui/base/input"
import { Separator } from "@/ui/base/separator"
import { LinkButton } from "@/ui/desktop/link-button"
import { hasUnresolvedConflicts, isConflictedFile } from "@/upstream/lib/status"
import { DiffSelectionType } from "@/upstream/models/diff/diff-selection"

import { DesktopCommitForm } from "./desktop-commit-form"
import { ChangesFileList } from "./file-list"

interface Props {
  filterVisible?: boolean
  repo: string
  selectionOf: (path: string) => import("@/upstream/models/diff").DiffSelection | null
  changes: FileChange[]
  branch: string | null
  selected: string | null
  selectedPaths?: readonly string[]
  onSelectionChange?: (paths: string[]) => void
  onDiscardMany?: (paths: string[]) => void
  includeOf: (path: string) => DiffSelectionType
  onSelect: (path: string) => void
  onIncludeChange: (path: string, include: boolean) => void
  onToggleAll: (include: boolean) => void
  onDiscard: (path: string) => void
  /** 右键菜单的「加进 .gitignore」：files 是按字面量的路径（含 `/目录`），rule 是 `*.ext` 规则 */
  onIgnore?: (kind: "files" | "rule", patterns: string[]) => void
  /** 变基冲突中：右键菜单只剩复制、显示、打开（Desktop rebaseConflictState） */
  rebaseConflict?: boolean
  /** 设置里选的编辑器名，给右键菜单的「用 … 打开」 */
  externalEditorLabel?: string | null
  /** 逐行追溯这个文件 */
  onBlame: (path: string) => void
  /** 切到 History，只列改过这个文件的提交 */
  onShowHistory?: (path: string) => void
  /** 提交人邮箱，用来生成头像首字母 */
  author?: { name: string; email: string }
  /** 写提交信息时 `#` 能补全的 issue 号 */
  issues: Issue[]
  onCommit: (summary: string, description: string, options: CommitOptions) => Promise<boolean>
  /** 贮藏全部改动 */
  onStashAll: () => void
  /** 撤销上一次提交：提交没了，改动退回暂存区 */
  onUndoCommit: () => void
  /** 修订上一次提交：把当前填的标题/描述覆盖上去 */
  onAmend: (summary: string, description: string) => Promise<boolean>
}

/** Changes 标签页。
 *
 * 列表和提交框沿用 Desktop 的 changes-list-container；工具栏按项目偏好合并为单行：
 *   .changes-list-container
 *     > 单行工具栏：全选、搜索、计数、筛选
 *     > .list        flex-grow:1; height:100%; overflow:hidden
 *     > 提交框
 * 高度靠这套规则成立，不再自己拼 min-h-0 链。 */
export function ChangesSidebar({
  filterVisible = true,
  repo,
  selectionOf,
  changes,
  branch,
  selected,
  selectedPaths,
  onSelectionChange,
  onDiscardMany,
  includeOf,
  onSelect,
  onIncludeChange,
  onToggleAll,
  onDiscard,
  onIgnore,
  rebaseConflict,
  externalEditorLabel,
  onBlame,
  onShowHistory,
  onCommit,
  onStashAll,
  onUndoCommit,
  onAmend,
  author,
  issues
}: Props) {
  const { t } = useTranslation()
  const [amendRequest, setAmendRequest] = useState(0)
  const [filters, setFilters] = useState(emptyChangesFilter)
  useEffect(() => {
    if (!filterVisible) setFilters(emptyChangesFilter)
  }, [filterVisible])
  const items = useMemo(
    () =>
      new Map<string, IChangesListItem>(
        changes.map(file => [
          file.path,
          {
            id: file.path,
            text: [file.path],
            change: {
              isIncludedInCommit: () => includeOf(file.path) === DiffSelectionType.All,
              isExcludedFromCommit: () => includeOf(file.path) === DiffSelectionType.None,
              isNew: () => file.change === "added",
              isUntracked: () => file.kind === "untracked",
              isModified: () => file.change === "modified",
              isDeleted: () => file.change === "deleted"
            }
          }
        ])
      ),
    [changes, includeOf]
  )
  const query = filters.filterText.toLowerCase()
  const shownItems = useMemo(
    () =>
      new Map(
        [...items].filter(([path, item]) => path.toLowerCase().includes(query) && applyFilters(item, true, filters))
      ),
    [items, query, filters]
  )
  const shown = changes.filter(file => shownItems.has(file.path))
  useEffect(() => {
    if (!selectedPaths || !onSelectionChange) return
    const visible = selectedPaths.filter(path => shownItems.has(path))
    if (visible.length !== selectedPaths.length) onSelectionChange(visible)
  }, [selectedPaths, onSelectionChange, shownItems])
  const committing = changes.filter(file => includeOf(file.path) !== DiffSelectionType.None)
  const hiddenSelected = isCommittingFileHiddenByFilter(
    committing.map(file => file.path),
    shownItems,
    changes.length,
    filters
  )
  const filterOptions = [
    "isIncludedInCommit",
    "isExcludedFromCommit",
    "isNewFile",
    "isModifiedFile",
    "isDeletedFile"
  ] as const
  const states = changes.map(c => includeOf(c.path))
  const on = states.filter(s => s !== DiffSelectionType.None).length
  const allChecked = changes.length > 0 && states.every(s => s === DiffSelectionType.All)
  const partial = on > 0 && !allChecked
  // 还带着冲突标记的文件不能提交——否则 `<<<<<<<` 就进历史了。原版同理。
  const unresolved = changes.filter(file => {
    const status = appStatus(file)
    return isConflictedFile(status) && hasUnresolvedConflicts(status)
  })
  return (
    <div className="changes-list-container">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b px-2.5">
        <Checkbox
          checked={allChecked}
          indeterminate={partial}
          onCheckedChange={onToggleAll}
          aria-label={t("changes.toggleAll")}
        />
        {filterVisible && (
          <Input
            value={filters.filterText}
            onChange={event => setFilters({ ...filters, filterText: event.currentTarget.value })}
            placeholder={t("changes.filter")}
            aria-label={t("changes.filter")}
            className="min-w-16 flex-1"
          />
        )}
        <span
          className="text-muted-foreground shrink-0 text-xs whitespace-nowrap"
          title={t("changes.fileCountFiltered", { shown: shown.length, total: changes.length })}>
          {shown.length}/{changes.length}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-xs"
                variant={hasActiveFilters(filters) ? "secondary" : "ghost"}
                aria-label={t("changes.filter")}
              />
            }>
            <FilterIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setAmendRequest(value => value + 1)}>
                {t("changes.amend")}
              </DropdownMenuItem>
              {filterOptions.map(key => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={filters[key]}
                  onCheckedChange={checked => setFilters({ ...filters, [key]: checked })}>
                  {t(`changes.${key}`)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={changes.length === 0} onClick={onStashAll}>
                {t("stash.stashAll")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onUndoCommit}>{t("changes.undoCommit")}</DropdownMenuItem>
              <DropdownMenuItem disabled={!hasActiveFilters(filters)} onClick={() => setFilters(emptyChangesFilter)}>
                {t("changes.clearFilters")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="list-scroller">
        {shown.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t(changes.length === 0 ? "changes.noChanges" : "changes.noFilterResults")}</EmptyTitle>
            </EmptyHeader>
            {changes.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => setFilters(emptyChangesFilter)}>
                {t("changes.clearFilters")}
              </Button>
            )}
          </Empty>
        )}
        {shown.length > 0 && (
          <ChangesFileList
            repo={repo}
            files={shown}
            selectedPaths={selectedPaths}
            onSelectionChange={onSelectionChange}
            onDiscardMany={onDiscardMany}
            selected={selected}
            includeOf={includeOf}
            onSelect={onSelect}
            onIncludeChange={onIncludeChange}
            onDiscard={onDiscard}
            onIgnore={onIgnore}
            rebaseConflict={rebaseConflict}
            externalEditorLabel={externalEditorLabel}
            onBlame={onBlame}
            onShowHistory={onShowHistory}
          />
        )}
      </div>

      {/* 原版 `.hidden-changes-warning`：筛选藏起了将要提交的文件时，在提交框上方提醒并给出调整入口；
          提交时的确认框（showPromptForCommittingFileHiddenByFilter）照旧 */}
      {hiddenSelected && (
        <div
          id="hidden-changes-warning"
          className="hidden-changes-warning relative z-10 -mb-px shrink-0 border-y px-2.5 py-[5px] leading-normal">
          <AlertIcon size={16} className="mr-[5px] inline-block align-text-bottom" />
          <span className="sr-only">{t("changes.warningPrefix")}</span>
          <span>{t("changes.hiddenChangesWarning")} </span>
          <LinkButton onClick={() => setFilters(emptyChangesFilter)}>
            {t("changes.adjustFilters", { count: committing.length })}
          </LinkButton>
        </div>
      )}
      <Separator />
      <DesktopCommitForm
        amendRequest={amendRequest}
        repo={repo}
        branch={branch}
        changes={changes}
        includeOf={includeOf}
        selectionOf={selectionOf}
        author={author}
        issues={issues}
        hiddenSelected={hiddenSelected}
        unresolved={unresolved.length > 0}
        onCommit={onCommit}
        onAmend={onAmend}
      />
    </div>
  )
}
