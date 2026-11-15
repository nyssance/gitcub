import { useTranslation } from "react-i18next"

import type { FileChange } from "@/models/repo-status"
import { List } from "@/ui/desktop/list"
import { DiffSelectionType } from "@/upstream/models/diff"

import { ChangedFile } from "./changed-file"

/** Desktop List owns focus, keyboard navigation and virtual rows; Item owns presentation. */
export function ChangesFileList({
  repo = "",
  files,
  selected,
  selectedPaths = selected ? [selected] : [],
  onSelectionChange,
  onDiscardMany,
  includeOf,
  onSelect,
  onIncludeChange,
  onDiscard,
  onIgnore = () => {},
  rebaseConflict = false,
  externalEditorLabel = null,
  onBlame,
  onShowHistory
}: {
  /** 仓库路径：右键菜单的复制完整路径、在 Finder 中显示、用编辑器打开都要它 */
  repo?: string
  files: FileChange[]
  selected: string | null
  selectedPaths?: readonly string[]
  onSelectionChange?: (paths: string[]) => void
  onDiscardMany?: (paths: string[]) => void
  includeOf: (path: string) => DiffSelectionType
  onSelect: (path: string) => void
  onIncludeChange: (path: string, include: boolean) => void
  onDiscard: (path: string) => void
  /** 加进 .gitignore：`files` 是按字面量的路径（含 `/目录`），`rule` 是 `*.ext` 这样的规则 */
  onIgnore?: (kind: "files" | "rule", patterns: string[]) => void
  /** 变基冲突中：右键菜单只剩复制、显示、打开 */
  rebaseConflict?: boolean
  /** 设置里选的编辑器名，给「用 … 打开」 */
  externalEditorLabel?: string | null
  onBlame: (path: string) => void
  onShowHistory?: (path: string) => void
}) {
  const { t } = useTranslation()
  const selectedSet = new Set(selectedPaths)
  const rows = files.flatMap((file, i) => (selectedSet.has(file.path) ? [i] : []))
  // Desktop selectedFileIDs：右键按在选区里的行上时菜单作用于整个选区，否则只作用于这一行
  const targets = (path: string) =>
    selectedSet.has(path) ? files.filter(file => selectedSet.has(file.path)) : files.filter(file => file.path === path)
  const includeFile = (path: string, include: boolean) => {
    const file = files.find(file => file.path === path)
    if (file?.submodule && file.change === "modified" && !file.submodule.commitChanged) return
    onIncludeChange(path, include)
  }
  return (
    <List
      role="list"
      ariaLabel={t("changes.fileCount", { count: files.length })}
      rowCount={files.length}
      rowHeight={29}
      selectedRows={rows}
      selectionMode={onSelectionChange ? "multi" : "single"}
      onSelectionChanged={rows => {
        const paths = rows.map(row => files[row].path)
        if (onSelectionChange) onSelectionChange(paths)
        else if (paths[0]) onSelect(paths[0])
      }}
      onRowClick={(row, source) => {
        // Desktop List dispatches each selected row for both Enter and Space.
        // Invert each file independently, including mixed inclusion states.
        const file = files[row]
        if (source.kind !== "keyboard" || !file) return
        if (file.submodule && file.change === "modified" && !file.submodule.commitChanged) return
        onIncludeChange(file.path, includeOf(file.path) === DiffSelectionType.None)
      }}
      rowRenderer={row => {
        const file = files[row]
        return (
          <ChangedFile
            repo={repo}
            file={file}
            menuFiles={targets(file.path)}
            include={includeOf(file.path)}
            selected={selectedSet.has(file.path)}
            rebaseConflict={rebaseConflict}
            externalEditorLabel={externalEditorLabel}
            onIncludeChange={includeFile}
            onDiscard={paths => (onDiscardMany ? onDiscardMany(paths) : onDiscard(paths[0]))}
            onIgnoreFiles={paths => onIgnore("files", paths)}
            onIgnoreRule={pattern => onIgnore("rule", [pattern])}
            onBlame={() => onBlame(file.path)}
            onShowHistory={onShowHistory && (() => onShowHistory(file.path))}
          />
        )
      }}
    />
  )
}
