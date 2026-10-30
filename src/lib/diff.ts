import { invoke } from "@tauri-apps/api/core"

import { tokenizeFile } from "@/lib/highlighter"
import type { FileChange } from "@/models/repo-status"
import { DiffParser } from "@/upstream/lib/diff-parser"
import type { ITokens } from "@/upstream/lib/highlighter/types"
import {
  type DiffHunk,
  type DiffLine,
  DiffLineType,
  DiffType,
  type IDiff,
  Image,
  type IRawDiff,
  type ISubmoduleDiff,
  type ITextDiff,
  parseLineEndingText
} from "@/upstream/models/diff"
import { DiffSelection, DiffSelectionType } from "@/upstream/models/diff/diff-selection"
import { AppFileStatusKind, type FileChange as DesktopFileChange } from "@/upstream/models/status"
import { type DiffExpansionKind, expandTextDiffHunk, expandWholeTextDiff } from "@/upstream/ui/diff/text-diff-expansion"

import { prepareImageSide } from "./image-data"

/** 决定用哪套 `git diff` 参数，对应原版 getWorkingDirectoryDiff 的分支。 */
export type FileKind = "new" | "renamed" | "normal"

export function fileKindOf(file: Pick<FileChange, "kind" | "change">): FileKind {
  if (file.kind === "untracked" || file.change === "added") return "new"
  // 重命名的文件在 HEAD 里是旧名字，拿新路径去和 HEAD 比会说「不存在」
  if (file.change === "renamed") return "renamed"
  return "normal"
}

/** 取原始 diff 文本并用移植自原版的解析器解析。
 *
 * 解析逻辑不自己写：`git diff` 的输出有大量边角（无尾换行标记、
 * 二进制、重命名、行尾变化警告），原版那 461 行是踩过坑的。 */
/** git 说它会改写这个文件的行尾。`core.autocrlf` 开着时，提交进去的内容和
 *  本地看到的不是同一份——这事只在 `git diff` 的 stderr 里说一句。 */
export interface LineEndingsChange {
  from: string
  to: string
}

export async function getDiff(
  repo: string,
  file: string,
  kind: FileKind,
  hideWhitespace = false
): Promise<{ diff: IRawDiff; lineEndings: LineEndingsChange | null }> {
  const raw = await invoke<{ text: string; lineEndings: LineEndingsChange | null }>("working_directory_diff", {
    repo,
    file,
    kind,
    hideWhitespace
  })
  return { diff: new DiffParser().parse(raw.text), lineEndings: raw.lineEndings }
}

/** 原版文本 diff 结构，供补丁生成与上下文展开共用。 */
export function toTextDiff(diff: IRawDiff): ITextDiff {
  return { ...diff, kind: DiffType.Text, text: diff.contents }
}

/** 全部可选行都选中的初始状态，对应原版「新改动默认全勾」。 */
export function initialSelection(diff: IRawDiff): DiffSelection {
  return DiffSelection.fromInitialSelection(DiffSelectionType.All).withSelectableLines(selectableLines(diff))
}

/** diff 里可被单独勾选的行（增/删行）在统一 diff 中的下标。 */
export function selectableLines(diff: IRawDiff): Set<number> {
  const out = new Set<number>()
  let index = 0
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === DiffLineType.Add || line.type === DiffLineType.Delete) {
        out.add(index)
      }
      index += 1
    }
  }
  return out
}

/** 按统一 diff 下标取行，供渲染和点击映射使用。 */
export function flattenLines(diff: IRawDiff): DiffLine[] {
  return diff.hunks.flatMap(h => [...h.lines])
}

/** Desktop expansion algorithms; the caller keeps the original patch immutable. */
export async function expandDiff(
  repo: string,
  file: string,
  diff: IRawDiff,
  target: { hunk: DiffHunk; kind: DiffExpansionKind } | null,
  sha?: string | null
): Promise<IRawDiff | undefined> {
  const text = sha
    ? await invoke<string>("file_at_commit", { repo, file, sha })
    : (await invoke<{ modified: string }>("file_contents", { repo, file })).modified
  const next = target
    ? expandTextDiffHunk(toTextDiff(diff), target.hunk, target.kind, text.split("\n"))
    : expandWholeTextDiff(toTextDiff(diff), text.split("\n"))
  return next ? { ...diff, hunks: next.hunks, maxLineNumber: next.maxLineNumber } : undefined
}

/** 两侧文件的词法分析结果，供 diff 行着色。
 *
 * 必须分别对完整文件做分析——统一 diff 不是合法源码。 */
export interface DiffTokens {
  oldTokens: ITokens | undefined
  newTokens: ITokens | undefined
}

export async function getSyntaxTokens(repo: string, file: string): Promise<DiffTokens> {
  const c = await invoke<{ original: string; modified: string }>("file_contents", {
    repo,
    file
  })
  // 两侧并行分析，各自跑在 worker 里
  const [oldTokens, newTokens] = await Promise.all([tokenizeFile(c.original, file), tokenizeFile(c.modified, file)])
  return { oldTokens, newTokens }
}

/** 历史 diff 的词法分析：取该提交及其父提交里那个文件的内容。
 *
 * 之前历史页没有高亮，就是因为只给工作区 diff 取了两侧内容。 */
export async function getCommitSyntaxTokens(repo: string, sha: string, file: string): Promise<DiffTokens> {
  const [original, modified] = await Promise.all([
    invoke<string>("file_at_commit", { repo, sha: `${sha}^`, file }).catch(() => ""),
    invoke<string>("file_at_commit", { repo, sha, file }).catch(() => "")
  ])
  const [oldTokens, newTokens] = await Promise.all([tokenizeFile(original, file), tokenizeFile(modified, file)])
  return { oldTokens, newTokens }
}

export async function getResolutionDiff(
  repo: string,
  file: string,
  target: { content: string } | { stage: "ours" | "theirs" },
  hideWhitespace = false
) {
  const result = await invoke<{ raw: string; oldContents: string; newContents: string }>("resolution_diff", {
    repo,
    file,
    target,
    hideWhitespace
  })
  return {
    diff: toTextDiff(new DiffParser().parse(result.raw)),
    oldContents: result.oldContents,
    newContents: result.newContents
  }
}

export async function getBranchMergeBaseDiff(
  repo: string,
  file: string,
  from: string,
  to: string,
  oldPath?: string,
  hideWhitespace = false
) {
  const raw = await invoke<string>("merge_base_diff", { repo, file, from, to, oldPath, hideWhitespace })
  return toTextDiff(new DiffParser().parse(raw))
}

/** Shared binary/image classification for Desktop-compatible results and the UI. */
export function diffKind(diff: IRawDiff, file: string): DiffType {
  if (!diff.isBinary) return DiffType.Text
  return /\.(png|apng|jpe?g|gif|ico|webp|bmp|avif|svg|dds)$/i.test(file) ? DiffType.Image : DiffType.Binary
}

type ImageSide = { data: string; mediaType: string; bytes: number }
function imageFromSide(rawSide: ImageSide | null): Image | undefined {
  const side = prepareImageSide(rawSide)
  if (!side) return undefined
  const raw = Uint8Array.from(atob(side.data), char => char.charCodeAt(0))
  // Desktop's historical alias is image/jpg; the native API uses image/jpeg.
  return new Image(raw.buffer, side.data, side.mediaType === "image/jpeg" ? "image/jpg" : side.mediaType, side.bytes)
}
export async function getWorkingDirectoryImage(repo: string, file: string) {
  const side = await invoke<ImageSide | null>("working_image", { repo, file })
  return imageFromSide(side)
}
export async function getBlobImage(repo: string, file: string, revision: string) {
  return imageFromSide(await invoke<ImageSide | null>("blob_image", { repo, file, revision }))
}
export async function getWorkingDirectoryDiff(
  repo: string,
  file: DesktopFileChange,
  hideWhitespace = false
): Promise<IDiff> {
  const status = file.status
  const kind =
    !status.submoduleStatus && (status.kind === AppFileStatusKind.New || status.kind === AppFileStatusKind.Untracked)
      ? "new"
      : status.kind === AppFileStatusKind.Renamed
        ? "renamed"
        : "normal"
  const { diff, lineEndings } = await getDiff(repo, file.path, kind, hideWhitespace)
  if (status.submoduleStatus) {
    const info = await invoke<{ fullPath: string; url: string | null; recorded: string | null; actual: string | null }>(
      "submodule_info",
      { repo, file: file.path }
    )
    const changed =
      status.submoduleStatus.commitChanged ||
      status.kind === AppFileStatusKind.New ||
      status.kind === AppFileStatusKind.Deleted
    return {
      kind: DiffType.Submodule,
      path: file.path,
      fullPath: info.fullPath,
      url: info.url,
      status: status.submoduleStatus,
      oldSHA: changed ? info.recorded : null,
      newSHA: changed ? info.actual : null
    } satisfies ISubmoduleDiff
  }
  switch (diffKind(diff, file.path)) {
    case DiffType.Binary:
      return { kind: DiffType.Binary }
    case DiffType.Image: {
      const result = await invoke<{ previous: ImageSide | null; current: ImageSide | null }>("image_diff", {
        repo,
        file: file.path
      })
      return { kind: DiffType.Image, previous: imageFromSide(result.previous), current: imageFromSide(result.current) }
    }
    default: {
      const from = lineEndings && parseLineEndingText(lineEndings.from)
      const to = lineEndings && parseLineEndingText(lineEndings.to)
      return { ...toTextDiff(diff), lineEndingsChange: from && to ? { from, to } : undefined }
    }
  }
}
