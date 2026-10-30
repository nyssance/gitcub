import { useTranslation } from "react-i18next"

import type { CommitFile } from "@/models/history"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/ui/base/context-menu"
import { Item, ItemActions, ItemContent, ItemTitle } from "@/ui/base/item"
import { Separator } from "@/ui/base/separator"
import { List } from "@/ui/desktop/list"
import { Path } from "@/ui/shared/path"
import { CommitStatusIcon } from "@/ui/shared/status-icon"

interface Props {
  files: CommitFile[]
  selected: string | null
  onSelect: (path: string) => void
  /** 右键「查看文件历史」：左栏切到只列改过这个文件的提交 */
  onShowHistory?: (path: string) => void
}

/** 某次提交改动的文件列表，位于右侧内容区的左栏。
 *
 * 对应 Desktop 的 renderFileList()，它外面包着一个可拖宽的 Resizable。
 * 尺寸照原版 `_commit-details.scss` / `_file-list.scss`：标题 30px 居中、行高 29px 含底边线、
 * 左右 10px 内边距、状态图标 16px；选中色与焦点态由 desktop.css 的 `.desktop-list-row` 提供。 */
export function CommitFileList({ files, selected, onSelect, onShowHistory }: Props) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="h-[30px] shrink-0 px-2.5 text-center leading-[30px]">
        {t("history.fileCount", { count: files.length })}
      </div>
      <Separator />
      <List
        ariaLabel={t("history.fileCount", { count: files.length })}
        rowCount={files.length}
        rowHeight={29}
        selectionMode="single"
        selectedRows={
          files.some(file => file.path === selected) ? [files.findIndex(file => file.path === selected)] : []
        }
        onSelectedRowChanged={row => {
          if (files[row]) onSelect(files[row].path)
        }}
        rowRenderer={row => {
          const f = files[row]
          const on = f.path === selected
          const item = (
            <Item
              key={f.path}
              size="sm"
              onClick={() => onSelect(f.path)}
              data-selected={on || undefined}
              className="desktop-list-row border-b-border h-[29px] min-w-0 cursor-default gap-0 rounded-none border-x-0 border-t-0 px-2.5 py-0">
              <ItemContent className="min-w-0 gap-0">
                <ItemTitle className="mr-[5px] flex w-full min-w-0 items-center gap-0 text-xs leading-normal font-normal">
                  <Path path={f.path} />
                </ItemTitle>
              </ItemContent>
              <ItemActions className="shrink-0 gap-0 [&_svg]:size-4">
                <CommitStatusIcon kind={f.kind} />
              </ItemActions>
            </Item>
          )
          if (!onShowHistory) return item
          return (
            <ContextMenu key={f.path}>
              <ContextMenuTrigger render={<div />}>{item}</ContextMenuTrigger>
              <ContextMenuContent
                // Portal mouse events still bubble through the file row; keep menu actions from re-selecting.
                onMouseDown={event => event.stopPropagation()}
                onMouseUp={event => event.stopPropagation()}
                onClick={event => event.stopPropagation()}>
                <ContextMenuItem onClick={() => onShowHistory(f.path)}>{t("history.showFileHistory")}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        }}
      />
    </div>
  )
}
