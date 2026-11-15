// Desktop MIT: row construction extracted verbatim from side-by-side-diff.tsx.
import memoize from "memoize-one"

import { assertNever, assertNonNullable, forceUnwrap } from "../../upstream/lib/fatal-error"
import type { ILineTokens } from "../../upstream/lib/highlighter/types"
import {
  type DiffHunk,
  DiffHunkExpansionType,
  type DiffLine,
  DiffLineType,
  type ITextDiff
} from "../../upstream/models/diff"
import {
  DiffRowType,
  getDiffTokens,
  MaxIntraLineDiffStringLength,
  type SimplifiedDiffRow,
  type SimplifiedDiffRowData
} from "../../upstream/ui/diff/diff-helpers"

type ModifiedLine = { line: DiffLine; diffLineNumber: number }
// Preserve original Desktop row builder.
export const getDiffRows = memoize(
  (diff: ITextDiff, showSideBySideDiff: boolean, enableDiffExpansion: boolean): ReadonlyArray<SimplifiedDiffRow> => {
    const outputRows = new Array<SimplifiedDiffRow>()

    diff.hunks.forEach((hunk, index) => {
      for (const row of getDiffRowsFromHunk(index, hunk, showSideBySideDiff, enableDiffExpansion)) {
        outputRows.push(row)
      }
    })

    return outputRows
  }
)

/**
 * Returns an array of rows with the needed data to render a side-by-side diff
 * with them.
 *
 * In some situations it will merge a deleted an added row into a single
 * modified row, in order to display them side by side (This happens when there
 * are consecutive added and deleted rows).
 *
 * @param hunk                The hunk to use to extract the rows data
 * @param showSideBySideDiff  Whether or not show the diff in side by side mode.
 */
function getDiffRowsFromHunk(
  hunkIndex: number,
  hunk: DiffHunk,
  showSideBySideDiff: boolean,
  enableDiffExpansion: boolean
): ReadonlyArray<SimplifiedDiffRow> {
  const rows = new Array<SimplifiedDiffRow>()

  /**
   * Array containing multiple consecutive added/deleted lines. This
   * is used to be able to merge them into modified rows.
   */
  let modifiedLines = new Array<ModifiedLine>()

  for (const [num, line] of hunk.lines.entries()) {
    const diffLineNumber = hunk.unifiedDiffStart + num

    if (line.type === DiffLineType.Delete || line.type === DiffLineType.Add) {
      modifiedLines.push({ line, diffLineNumber })
      continue
    }

    if (modifiedLines.length > 0) {
      // If the current line is not added/deleted and we have any added/deleted
      // line stored, we need to process them.
      for (const row of getModifiedRows(modifiedLines, showSideBySideDiff)) {
        rows.push(row)
      }
      modifiedLines = []
    }

    if (line.type === DiffLineType.Hunk) {
      rows.push({
        type: DiffRowType.Hunk,
        content: line.text,
        expansionType: enableDiffExpansion ? hunk.expansionType : DiffHunkExpansionType.None,
        hunkIndex
      })
      continue
    }

    if (line.type === DiffLineType.Context) {
      assertNonNullable(line.oldLineNumber, `No oldLineNumber for ${diffLineNumber}`)
      assertNonNullable(line.newLineNumber, `No newLineNumber for ${diffLineNumber}`)

      rows.push({
        type: DiffRowType.Context,
        content: line.content,
        beforeLineNumber: line.oldLineNumber,
        afterLineNumber: line.newLineNumber,
        beforeTokens: [],
        afterTokens: []
      })
      continue
    }

    assertNever(line.type, `Invalid line type: ${line.type}`)
  }

  // Do one more pass to process the remaining list of modified lines.
  if (modifiedLines.length > 0) {
    for (const row of getModifiedRows(modifiedLines, showSideBySideDiff)) {
      rows.push(row)
    }
  }

  return rows
}

function getModifiedRows(
  addedOrDeletedLines: ReadonlyArray<ModifiedLine>,
  showSideBySideDiff: boolean
): ReadonlyArray<SimplifiedDiffRow> {
  if (addedOrDeletedLines.length === 0) {
    return []
  }
  const hunkStartLine = addedOrDeletedLines[0].diffLineNumber
  const addedLines = new Array<ModifiedLine>()
  const deletedLines = new Array<ModifiedLine>()

  for (const line of addedOrDeletedLines) {
    if (line.line.type === DiffLineType.Add) {
      addedLines.push(line)
    } else if (line.line.type === DiffLineType.Delete) {
      deletedLines.push(line)
    }
  }

  const output = new Array<SimplifiedDiffRow>()

  const diffTokensBefore = new Array<ILineTokens | undefined>()
  const diffTokensAfter = new Array<ILineTokens | undefined>()

  // To match the behavior of github.com, we only highlight differences between
  // lines on hunks that have the same number of added and deleted lines.
  const shouldDisplayDiffInChunk = addedLines.length === deletedLines.length

  if (shouldDisplayDiffInChunk) {
    for (let i = 0; i < deletedLines.length; i++) {
      const addedLine = addedLines[i]
      const deletedLine = deletedLines[i]

      if (
        addedLine.line.content.length < MaxIntraLineDiffStringLength &&
        deletedLine.line.content.length < MaxIntraLineDiffStringLength
      ) {
        const { before, after } = getDiffTokens(deletedLine.line.content, addedLine.line.content)
        diffTokensBefore[i] = before
        diffTokensAfter[i] = after
      }
    }
  }

  let indexModifiedRow = 0

  while (showSideBySideDiff && indexModifiedRow < addedLines.length && indexModifiedRow < deletedLines.length) {
    const addedLine = forceUnwrap("Unexpected null line", addedLines[indexModifiedRow])
    const deletedLine = forceUnwrap("Unexpected null line", deletedLines[indexModifiedRow])

    // Modified lines
    output.push({
      type: DiffRowType.Modified,
      beforeData: getDataFromLine(deletedLine, "oldLineNumber", diffTokensBefore.shift()),
      afterData: getDataFromLine(addedLine, "newLineNumber", diffTokensAfter.shift()),
      hunkStartLine
    })

    indexModifiedRow++
  }

  for (let i = indexModifiedRow; i < deletedLines.length; i++) {
    const line = forceUnwrap("Unexpected null line", deletedLines[i])

    output.push({
      type: DiffRowType.Deleted,
      data: getDataFromLine(line, "oldLineNumber", diffTokensBefore.shift()),
      hunkStartLine
    })
  }

  for (let i = indexModifiedRow; i < addedLines.length; i++) {
    const line = forceUnwrap("Unexpected null line", addedLines[i])

    // Added line
    output.push({
      type: DiffRowType.Added,
      data: getDataFromLine(line, "newLineNumber", diffTokensAfter.shift()),
      hunkStartLine
    })
  }

  return output
}

function getDataFromLine(
  { line, diffLineNumber: _diffLineNumber }: { line: DiffLine; diffLineNumber: number },
  lineToUse: "oldLineNumber" | "newLineNumber",
  diffTokens: ILineTokens | undefined
): SimplifiedDiffRowData {
  const lineNumber = forceUnwrap(`Expecting ${lineToUse} value for ${line}`, line[lineToUse])

  const tokens = new Array<ILineTokens>()

  if (diffTokens !== undefined) {
    tokens.push(diffTokens)
  }

  return {
    content: line.content,
    lineNumber,
    diffLineNumber: line.originalLineNumber,
    noNewLineIndicator: line.noTrailingNewLine,
    tokens
  }
}
