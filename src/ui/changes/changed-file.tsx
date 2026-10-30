import { ArrowRightIcon } from "@primer/octicons-react"
import { useTranslation } from "react-i18next"

import { shell } from "@/lib/app-shell"
import { changesContextMenu, type ChangesMenuEntry, type MenuPlatform } from "@/lib/changes-context-menu"
import { ipc } from "@/lib/ipc"
import { __DARWIN__, __WIN32__ } from "@/lib/platform-flags"
import type { FileChange } from "@/models/repo-status"
import { Checkbox } from "@/ui/base/checkbox"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from "@/ui/base/context-menu"
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/ui/base/item"
import { Path } from "@/ui/shared/path"
import { ChangeStatusIcon } from "@/ui/shared/status-icon"
import { DiffSelectionType } from "@/upstream/models/diff/diff-selection"

interface Props {
  /** 仓库路径：复制完整路径、在 Finder 中显示、用编辑器打开都要它 */
  repo: string
  file: FileChange
  /** 右键菜单作用于哪些文件：行在当前多选里就是整个选区，否则只有这一行 */
  menuFiles: ReadonlyArray<FileChange>
  /** 三态：全选 / 部分 / 未选 —— 由行选择派生 */
  include: DiffSelectionType
  selected: boolean
  /** 变基冲突中：菜单只剩复制、显示、打开（Desktop getRebaseContextMenu） */
  rebaseConflict?: boolean
  /** 设置里选的编辑器名，给「用 … 打开」 */
  externalEditorLabel?: string | null
  onSelect?: () => void
  /** 勾选 / 取消某个文件；菜单里的「纳入 / 排除所选文件」逐个文件调它 */
  onIncludeChange: (path: string, include: boolean) => void
  /** 丢弃这些路径的改动（上层确认） */
  onDiscard: (paths: string[]) => void
  /** 把这些路径（或 `/目录`）加进 .gitignore */
  onIgnoreFiles: (paths: string[]) => void
  /** 把 `*.ext` 这样的规则加进 .gitignore */
  onIgnoreRule: (pattern: string) => void
  /** 逐行追溯这个文件 */
  onBlame: () => void
  /** 切到 History，只列改过这个文件的提交 */
  onShowHistory?: () => void
}

const platform: MenuPlatform = __DARWIN__ ? "macos" : __WIN32__ ? "windows" : "linux"

/** 改动列表的一行：复选框 | 路径（目录淡化）| 状态图标。
 *
 * 保留 Desktop 的文件状态语义；展示使用 shadcn Item 和 Base UI 三态 Checkbox。
 * 尺寸照原版 `_file-list.scss` / `_path-label.scss`：行高 29px 含 1px 底边线、左右 10px 内边距、
 * 复选框占 20px、路径右侧留 5px、重命名箭头 16px 两侧各 5px、状态图标 16px。
 * 选中色、悬停色和「有焦点时状态图标用正文色」由 desktop.css 的 `.desktop-list-row` 规则
 * 照原版 `_list.scss` / `_file-list.scss` 提供。
 * 右键菜单照 Desktop filter-changes-list.tsx 的 onItemContextMenu（lib/changes-context-menu.ts），
 * 末尾加本项目的逐行追溯与文件历史。 */
export function ChangedFile({
  repo,
  file,
  menuFiles,
  include,
  selected,
  rebaseConflict = false,
  externalEditorLabel = null,
  onSelect,
  onIncludeChange,
  onDiscard,
  onIgnoreFiles,
  onIgnoreRule,
  onBlame,
  onShowHistory
}: Props) {
  const { t } = useTranslation()
  const sub = file.submodule
  // 子模块的三种脏法里只有「指向的提交变了」能提交进父仓库：
  //   - 只有内部改动 → 勾了也提交不了任何东西，复选框直接禁用
  //   - 指向变了 + 内部还有脏东西 → 半选：进提交的只有「指向变了」这部分
  // 规则照原版 filter-changes-list.tsx。
  const uncommittable = sub !== null && file.change === "modified" && !sub.commitChanged
  const partial = sub !== null && (sub.commitChanged || file.change === "added") && (sub.modified || sub.untracked)
  const entries = changesContextMenu({
    repositoryPath: repo,
    file,
    files: menuFiles,
    rebaseConflict,
    externalEditorLabel,
    platform,
    t: (key, options) => t(key, options),
    actions: {
      discard: onDiscard,
      ignoreFiles: onIgnoreFiles,
      ignoreRule: onIgnoreRule,
      // 半选的子模块只有「指向变了」那部分能进提交；纳入 / 排除照 Desktop onIncludeChanged 逐个改
      includeChanged: (changed, include) => {
        if (changed.submodule && changed.change === "modified" && !changed.submodule.commitChanged) return
        onIncludeChange(changed.path, include)
      },
      copy: text => void navigator.clipboard.writeText(text),
      reveal: path => shell.showItemInFolder(path),
      openInEditor: path => void ipc.openInEditor(path).catch(error => log.error("Unable to open in editor", error)),
      openWithDefault: path => void shell.openPath(path)
    }
  })

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>
        <Item
          size="sm"
          onClick={onSelect}
          data-selected={selected || undefined}
          className="desktop-list-row border-b-border h-[29px] cursor-default gap-0 rounded-none border-x-0 border-t-0 px-2.5 py-0">
          <ItemMedia className="w-5 justify-start">
            <Checkbox
              // 原版复选框 tabIndex=-1：焦点落在行上，空格切换勾选（List 的键盘行点击已处理）
              tabIndex={-1}
              // 半选的子模块不能同时是「选中」：进提交的只有「指向变了」那一部分
              checked={!uncommittable && !partial && include === DiffSelectionType.All}
              indeterminate={
                !uncommittable && (partial ? include !== DiffSelectionType.None : include === DiffSelectionType.Partial)
              }
              disabled={uncommittable}
              onCheckedChange={include => onIncludeChange(file.path, include)}
              onMouseDown={e => e.stopPropagation()}
              onMouseUp={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
              aria-label={t("changes.include", { path: file.path })}
              title={
                uncommittable
                  ? t("changes.submoduleUncommittable")
                  : partial
                    ? t("changes.submodulePartial")
                    : undefined
              }
              className="size-3.5"
            />
          </ItemMedia>
          <ItemContent className="min-w-0 gap-0">
            <ItemTitle className="mr-[5px] flex w-full min-w-0 items-center gap-0 text-xs leading-normal font-normal">
              {/* 重命名要把旧名字也显示出来，否则「文件不见了、多了个没见过的」；
                  原版给两段各一半宽度（PathLabel segmentWidth），这里用等分 flex */}
              {file.oldPath ? (
                <>
                  <Path path={file.oldPath} className="flex-1 basis-0" />
                  <ArrowRightIcon size={16} className="mx-[5px] shrink-0" />
                  <Path path={file.path} className="flex-1 basis-0" />
                </>
              ) : (
                <Path path={file.path} />
              )}
            </ItemTitle>
          </ItemContent>
          <ItemActions className="gap-0 [&_svg]:size-4">
            <ChangeStatusIcon file={file} />
          </ItemActions>
        </Item>
      </ContextMenuTrigger>
      <ContextMenuContent
        // Portal mouse events still bubble through React's file row. Native
        // Desktop menus do not: keep menu actions from collapsing selection.
        onMouseDown={event => event.stopPropagation()}
        onMouseUp={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}>
        <MenuEntries entries={entries} />
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onBlame}>{t("blame.open")}</ContextMenuItem>
        {onShowHistory && <ContextMenuItem onClick={onShowHistory}>{t("history.showFileHistory")}</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 把菜单模型画成 shadcn ContextMenu：条目、分隔线、子菜单 */
function MenuEntries({ entries }: { entries: ChangesMenuEntry[] }) {
  return entries.map((entry, index) => {
    if (entry.type === "separator") return <ContextMenuSeparator key={`separator-${index}`} />
    if (entry.type === "submenu")
      return (
        <ContextMenuSub key={entry.id}>
          <ContextMenuSubTrigger disabled={!entry.enabled}>{entry.label}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <MenuEntries entries={entry.items} />
          </ContextMenuSubContent>
        </ContextMenuSub>
      )
    return (
      <ContextMenuItem
        key={entry.id}
        disabled={!entry.enabled}
        variant={entry.id === "discard" ? "destructive" : "default"}
        onClick={entry.action}>
        {entry.label}
      </ContextMenuItem>
    )
  })
}
