import type { CommitFile } from "@/models/history"

/** 一次提交改动集的增删总行数，对应 Desktop `log.ts` parseRawLogWithNumstat 的 linesAdded / linesDeleted：
 *  逐文件累加 numstat，二进制文件的 `-`（这里是 null）按 0 计。 */
export function changesetLineCounts(files: ReadonlyArray<CommitFile>): { linesAdded: number; linesDeleted: number } {
  let linesAdded = 0
  let linesDeleted = 0
  for (const file of files) {
    linesAdded += file.linesAdded ?? 0
    linesDeleted += file.linesDeleted ?? 0
  }
  return { linesAdded, linesDeleted }
}

/** Desktop `expandable-commit-summary.tsx` renderLinesChanged：两个数都是 0（或多选提交）时不显示 */
export function showsLineCounts(counts: { linesAdded: number; linesDeleted: number }, selectedCommits = 1): boolean {
  return selectedCommits === 1 && (counts.linesAdded !== 0 || counts.linesDeleted !== 0)
}
