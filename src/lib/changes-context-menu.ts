import type { FileChange } from "@/models/repo-status"

/** 改动列表行的右键菜单，一比一照 Desktop `filter-changes-list.tsx` 的 getDefaultContextMenu /
 *  getRebaseContextMenu 组装：丢弃、忽略（文件 / 文件夹子菜单 / 所选文件 / 按扩展名最多五条）、
 *  多选时的纳入 / 排除、复制路径、在 Finder 中显示、用外部编辑器打开、用默认程序打开。
 *  菜单只描述条目，动作由调用方注入；展示用 shadcn ContextMenu（changed-file.tsx）。 */

export type ChangesMenuEntry =
  | { type: "item"; id: string; label: string; enabled: boolean; action: () => void }
  | { type: "separator" }
  | { type: "submenu"; id: string; label: string; enabled: boolean; items: ChangesMenuEntry[] }

export type MenuPlatform = "macos" | "windows" | "linux"

export interface ChangesMenuActions {
  /** 丢弃这些路径的改动（调用方负责确认） */
  discard: (paths: string[]) => void
  /** Desktop onIgnoreFile → appendIgnoreFile：路径按字面量加进 .gitignore（特殊字符转义） */
  ignoreFiles: (paths: string[]) => void
  /** Desktop onIgnorePattern → appendIgnoreRule：`*.ext` 这样的规则 */
  ignoreRule: (pattern: string) => void
  includeChanged: (file: FileChange, include: boolean) => void
  copy: (text: string) => void
  reveal: (fullPath: string) => void
  openInEditor: (fullPath: string) => void
  openWithDefault: (fullPath: string) => void
}

export interface ChangesMenuContext {
  repositoryPath: string
  /** 右键按在哪一行上 */
  file: FileChange
  /** 菜单作用于哪些文件：行在当前多选里就是整个选区，否则只有这一行（Desktop selectedFileIDs） */
  files: ReadonlyArray<FileChange>
  /** 变基冲突中：只剩复制、显示、打开，未跟踪的文件还能丢弃（getRebaseContextMenu） */
  rebaseConflict: boolean
  /** 设置里选的编辑器名；没有时按 Desktop 的 DefaultEditorLabel */
  externalEditorLabel: string | null
  platform: MenuPlatform
  t: (key: string, options?: Record<string, unknown>) => string
  actions: ChangesMenuActions
}

/** Desktop `models/status.ts` GitIgnoreFileName */
const GitIgnoreFileName = ".gitignore"
/** Desktop `ui/lib/context-menu.ts` RestrictedFileExtensions：只有 Windows 限制 */
const RestrictedFileExtensions = [".cmd", ".exe", ".bat", ".sh"]

export function isSafeFileExtension(extension: string, platform: MenuPlatform): boolean {
  if (platform === "windows") return !RestrictedFileExtensions.includes(extension.toLowerCase())
  return true
}

/** Node `path.basename` 的最后一段（Git 路径永远用 `/`） */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

/** Node `path.extname`：点文件（`.gitignore`）没有扩展名 */
export function extname(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot)
}

/** Desktop `Path.join(repository.path, file.path)` / `Path.normalize(file.path)`：Windows 上换成反斜杠 */
export function fullPath(repositoryPath: string, path: string, platform: MenuPlatform): string {
  const separator = platform === "windows" ? "\\" : "/"
  const root = repositoryPath.endsWith(separator) ? repositoryPath.slice(0, -1) : repositoryPath
  return `${root}${separator}${relativePath(path, platform)}`
}

export function relativePath(path: string, platform: MenuPlatform): string {
  return platform === "windows" ? path.replaceAll("/", "\\") : path
}

export function changesContextMenu(context: ChangesMenuContext): ChangesMenuEntry[] {
  return context.rebaseConflict ? rebaseContextMenu(context) : defaultContextMenu(context)
}

function defaultContextMenu(context: ChangesMenuContext): ChangesMenuEntry[] {
  const { file, files, t, actions } = context
  const { path } = file
  const paths = files.map(file => file.path)
  const extensions = new Set<string>()
  for (const selected of files) {
    const extension = extname(selected.path)
    if (extension.length) extensions.add(extension)
  }

  const items: ChangesMenuEntry[] = [discardItem(context, paths), { type: "separator" }]
  if (paths.length === 1) {
    const enabled = basename(path) !== GitIgnoreFileName
    items.push({
      type: "item",
      id: "ignore-file",
      label: t("changes.menu.ignoreFile"),
      enabled,
      action: () => actions.ignoreFiles([path])
    })
    // Even on Windows, the path separator is '/' for git operations so cannot use Path.sep
    const pathComponents = path.split("/").slice(0, -1)
    if (pathComponents.length > 0) {
      const submenu = pathComponents.map((_, index): ChangesMenuEntry => {
        const label = `/${pathComponents.slice(0, pathComponents.length - index).join("/")}`
        return {
          type: "item",
          id: `ignore-folder:${label}`,
          label,
          enabled: true,
          action: () => actions.ignoreFiles([label])
        }
      })
      items.push({
        type: "submenu",
        id: "ignore-folder",
        label: t("changes.menu.ignoreFolder"),
        enabled,
        items: submenu
      })
    }
  } else if (paths.length > 1) {
    // Filter out any .gitignores that happens to be selected, ignoring those doesn't make sense.
    const ignorable = paths.filter(path => basename(path) !== GitIgnoreFileName)
    items.push({
      type: "item",
      id: "ignore-selected",
      label: t("changes.menu.ignoreSelected", { count: paths.length }),
      enabled: ignorable.length > 0,
      action: () => actions.ignoreFiles(ignorable)
    })
  }
  // Five menu items should be enough for everyone
  for (const extension of [...extensions].slice(0, 5)) {
    items.push({
      type: "item",
      id: `ignore-extension:${extension}`,
      label: t("changes.menu.ignoreExtension", { extension }),
      enabled: true,
      action: () => actions.ignoreRule(`*${extension}`)
    })
  }

  if (paths.length > 1) {
    items.push(
      { type: "separator" },
      {
        type: "item",
        id: "include-selected",
        label: t("changes.includeSelected"),
        enabled: true,
        action: () => {
          for (const selected of files) actions.includeChanged(selected, true)
        }
      },
      {
        type: "item",
        id: "exclude-selected",
        label: t("changes.excludeSelected"),
        enabled: true,
        action: () => {
          for (const selected of files) actions.includeChanged(selected, false)
        }
      },
      { type: "separator" },
      copySelectedPathsItem(context),
      copySelectedRelativePathsItem(context)
    )
  } else {
    items.push({ type: "separator" }, copyPathItem(context), copyRelativePathItem(context))
  }

  items.push({ type: "separator" }, ...openItems(context))
  return items
}

function rebaseContextMenu(context: ChangesMenuContext): ChangesMenuEntry[] {
  const { file } = context
  const items: ChangesMenuEntry[] = []
  if (file.kind === "untracked") items.push(discardItem(context, [file.path]), { type: "separator" })
  items.push(copyPathItem(context), copyRelativePathItem(context), { type: "separator" }, ...openItems(context))
  return items
}

/** Desktop getDiscardChangesMenuItemLabel：本项目丢弃前总会确认，所以总带省略号 */
function discardItem(context: ChangesMenuContext, paths: string[]): ChangesMenuEntry {
  const label =
    paths.length === 1
      ? context.t("changes.menu.discard")
      : context.t("changes.menu.discardSelected", { count: paths.length })
  return { type: "item", id: "discard", label, enabled: true, action: () => context.actions.discard(paths) }
}

function copyPathItem(context: ChangesMenuContext): ChangesMenuEntry {
  const { repositoryPath, file, platform, t, actions } = context
  return {
    type: "item",
    id: "copy-path",
    label: t("changes.menu.copyFilePath"),
    enabled: true,
    action: () => actions.copy(fullPath(repositoryPath, file.path, platform))
  }
}

function copyRelativePathItem(context: ChangesMenuContext): ChangesMenuEntry {
  const { file, platform, t, actions } = context
  return {
    type: "item",
    id: "copy-relative-path",
    label: t("changes.menu.copyRelativeFilePath"),
    enabled: true,
    action: () => actions.copy(relativePath(file.path, platform))
  }
}

/** Desktop 用 EOL 连接多条路径；Git 路径这里统一用 `\n` */
function copySelectedPathsItem(context: ChangesMenuContext): ChangesMenuEntry {
  const { repositoryPath, files, platform, t, actions } = context
  return {
    type: "item",
    id: "copy-paths",
    label: t("changes.menu.copyPaths"),
    enabled: true,
    action: () => actions.copy(files.map(file => fullPath(repositoryPath, file.path, platform)).join("\n"))
  }
}

function copySelectedRelativePathsItem(context: ChangesMenuContext): ChangesMenuEntry {
  const { files, platform, t, actions } = context
  return {
    type: "item",
    id: "copy-relative-paths",
    label: t("changes.menu.copyRelativePaths"),
    enabled: true,
    action: () => actions.copy(files.map(file => relativePath(file.path, platform)).join("\n"))
  }
}

/** 删除的文件没有东西可显示或打开；默认程序还要扩展名安全（Windows） */
function openItems(context: ChangesMenuContext): ChangesMenuEntry[] {
  const { repositoryPath, file, platform, externalEditorLabel, t, actions } = context
  const enabled = file.change !== "deleted"
  const target = fullPath(repositoryPath, file.path, platform)
  return [
    {
      type: "item",
      id: "reveal",
      label: t(
        platform === "macos"
          ? "changes.menu.revealInFinder"
          : platform === "windows"
            ? "changes.menu.showInExplorer"
            : "changes.menu.showInFileManager"
      ),
      enabled,
      action: () => actions.reveal(target)
    },
    {
      type: "item",
      id: "open-in-editor",
      label: externalEditorLabel
        ? t("nativeMenu.openIn", { name: externalEditorLabel })
        : t("changes.menu.openInExternalEditor"),
      enabled,
      action: () => actions.openInEditor(target)
    },
    {
      type: "item",
      id: "open-with-default",
      label: t("changes.menu.openWithDefaultProgram"),
      enabled: enabled && isSafeFileExtension(extname(file.path), platform),
      action: () => actions.openWithDefault(target)
    }
  ]
}
