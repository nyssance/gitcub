import { invoke } from "@tauri-apps/api/core"

import { appStatus } from "@/lib/desktop-status"
import { fileKindOf, getDiff, toTextDiff } from "@/lib/diff"
import { ipc } from "@/lib/ipc"
import type { FileChange } from "@/models/repo-status"
import { formatPatch, formatPatchToDiscardChanges } from "@/upstream/lib/patch-formatter"
import type { IRawDiff } from "@/upstream/models/diff"
import { DiffSelection, DiffSelectionType } from "@/upstream/models/diff/diff-selection"
import { WorkingDirectoryFileChange } from "@/upstream/models/status"

/** 一个文件在这次提交里怎么处理。和 src-tauri/src/stage.rs 的 StageFile 对应。 */
interface StagePlan {
  path: string
  oldPath: string | null
  include: "all" | "none" | "partial"
  patch: string | null
}

/** 把整份勾选状态一次性落到 index。
 *
 * **一次 IPC**，不是一个文件一次：后者在大改动上是灾难——5 万文件的仓库里改
 * 2000 个，光暂存就要一分多钟（每次都重写一遍整个 index）。批量之后同样的量
 * 是一秒多。
 *
 * 部分选中的那几个仍要单独生成补丁（得读它的 diff），但这类本来就少：
 * 用户得手动去点行才会产生。 */
export async function applySelection(
  repo: string,
  files: Array<{
    file: FileChange
    include: DiffSelectionType
    selection: DiffSelection | null
    expectedDiff?: IRawDiff
  }>
): Promise<void> {
  const plans: StagePlan[] = []

  for (const { file, include, selection, expectedDiff } of files) {
    // include 是复选框的状态，selection 是行级选择。**两个都要看**：
    // 没打开过的文件 selection 是 null，只看它的话「取消勾选」会失效
    // （那是之前踩过的坑：没勾的文件照样被提交进去）。
    const type =
      include === DiffSelectionType.None
        ? DiffSelectionType.None
        : (selection?.getSelectionType() ?? DiffSelectionType.All)
    const base = { path: file.path, oldPath: file.oldPath }

    if (type === DiffSelectionType.None) {
      plans.push({ ...base, include: "none", patch: null })
      continue
    }
    // 走到这里 selection 必然不是 null：null 时上面已经算成 All 了
    if (type === DiffSelectionType.All || selection === null) {
      plans.push({ ...base, include: "all", patch: null })
      continue
    }

    const { diff: raw } = await getDiff(repo, file.path, fileKindOf(file))
    if (expectedDiff && raw.contents !== expectedDiff.contents)
      throw new Error("The file changed after line selection. Review the diff before committing.")
    // formatPatch 要的是 ITextDiff：IRawDiff 加上 kind/text 两个字段
    const diff = toTextDiff(raw)
    const wd = new WorkingDirectoryFileChange(file.path, appStatus(file), selection)
    const patch = formatPatch(wd, diff)
    // 补丁为空 = 这次没有任何行被选中，等同于不进提交
    plans.push(patch === null ? { ...base, include: "none", patch: null } : { ...base, include: "partial", patch })
  }

  await invoke<void>("apply_selection", { repo, files: plans })
}

/** 只丢弃指定的那几行（统一 diff 下标）。
 *
 * 照原版 discardChangesFromSelection：用 patch-formatter 生成一份**反向**补丁
 * （选中的增行写成删、删行写成增），打到工作区就等于把这几行的改动撤掉。
 * 整文件丢弃走的是另一条路（进废纸篓再复位），这里只动文件内容，不碰文件本身。 */
export async function discardLines(repo: string, file: string, raw: IRawDiff, lines: number[]): Promise<void> {
  if (lines.length === 0) return
  const change = (await ipc.repoStatus(repo)).changes.find(change => change.path === file)
  if (!change) throw new Error("The file is no longer changed. Refresh the diff.")
  const current = (await getDiff(repo, file, fileKindOf(change))).diff
  if (current.contents !== raw.contents)
    throw new Error("The file changed after opening the menu. Review the diff before discarding lines.")
  let sel = DiffSelection.fromInitialSelection(DiffSelectionType.None)
  for (const i of lines) sel = sel.withLineSelection(i, true)

  return discardSelection(repo, file, toTextDiff(raw), sel)
}

export async function discardSelection(
  repo: string,
  file: string,
  diff: ReturnType<typeof toTextDiff>,
  selection: DiffSelection
): Promise<void> {
  const patch = formatPatchToDiscardChanges(file, diff, selection)
  if (patch === null) return
  await invoke<void>("discard_lines", { repo, patch })
}
