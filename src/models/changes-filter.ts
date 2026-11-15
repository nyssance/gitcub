import type { WorkingDirectoryFileChange } from "@/upstream/models/status"

export interface IFileListFilterState {
  filterText: string
  isIncludedInCommit: boolean
  isExcludedFromCommit: boolean
  isNewFile: boolean
  isModifiedFile: boolean
  isDeletedFile: boolean
}

/** Desktop 过滤函数实际读取的字段；不引入其 Electron 列表组件依赖。 */
export interface IChangesListItem {
  id: string
  text: readonly string[]
  change: Pick<
    WorkingDirectoryFileChange,
    "isIncludedInCommit" | "isExcludedFromCommit" | "isNew" | "isUntracked" | "isModified" | "isDeleted"
  >
}

export const emptyChangesFilter: IFileListFilterState = {
  filterText: "",
  isIncludedInCommit: false,
  isExcludedFromCommit: false,
  isNewFile: false,
  isModifiedFile: false,
  isDeletedFile: false
}
