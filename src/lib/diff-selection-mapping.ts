import type { IRawDiff } from "../upstream/models/diff"
import { DiffSelection, DiffSelectionType } from "../upstream/models/diff/diff-selection"

/** Git may remove whole hunks when ignoring whitespace. Never treat display indices as patch indices. */
export function diffLineMapping(full: IRawDiff, display: IRawDiff): (number | undefined)[] {
  const canonical = new Map(
    full.hunks
      .flatMap(h => h.lines)
      .map((line, index) => [`${line.type}:${line.oldLineNumber}:${line.newLineNumber}`, index])
  )
  return display.hunks
    .flatMap(h => h.lines)
    .map(line => canonical.get(`${line.type}:${line.oldLineNumber}:${line.newLineNumber}`))
}
export function projectDiffSelection(
  selection: DiffSelection,
  mapping: (number | undefined)[],
  selectable: Set<number>
): DiffSelection {
  let result = DiffSelection.fromInitialSelection(DiffSelectionType.None).withSelectableLines(selectable)
  for (const index of selectable) {
    const original = mapping[index]
    if (original !== undefined && selection.isSelected(original)) result = result.withLineSelection(index, true)
  }
  return result
}
export function restoreDiffSelection(
  full: DiffSelection,
  display: DiffSelection,
  mapping: (number | undefined)[]
): DiffSelection {
  let result = full
  mapping.forEach((original, index) => {
    if (original !== undefined && display.isSelectable(index) && full.isSelectable(original))
      result = result.withLineSelection(original, display.isSelected(index))
  })
  return result
}
