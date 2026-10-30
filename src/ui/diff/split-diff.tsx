import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { type DiffTokens, toTextDiff } from "@/lib/diff"
import type { ILineTokens } from "@/upstream/lib/highlighter/types"
import {
  DiffHunkExpansionType,
  DiffLineType,
  type DiffSelection,
  DiffSelectionType,
  type IRawDiff
} from "@/upstream/models/diff"
import { findInteractiveOriginalDiffRange } from "@/upstream/ui/diff/diff-explorer"
import { getLineWidthFromDigitCount, getNumberOfDigits } from "@/upstream/ui/diff/diff-helpers"
import { getTokens } from "@/upstream/ui/diff/get-tokens"

import {
  DiffColumn,
  type DiffRow,
  DiffRowType,
  isRowChanged,
  type SimplifiedDiffRowData
} from "../../upstream/ui/diff/diff-helpers"
import { getDiffRows } from "./desktop-diff-rows"
import { type CheckBoxIdentifier, type IRowSelectableGroup, SideBySideDiffRow } from "./side-by-side-diff-row"

export function SplitDiff({
  hideWhitespace = false,
  onHideWhitespaceChange,
  split = true,
  diff,
  selection,
  onChange,
  onExpand,
  onContextLine,
  onTextContext,
  onSearchResults,
  query,
  searchStep,
  tokens,
  wrap
}: {
  onSearchResults?: (result: { current: number; total: number }) => void
  onTextContext?: (actions: { text: string; selectAll: () => void }) => void
  hideWhitespace?: boolean
  onHideWhitespaceChange?: (hide: boolean) => void
  split?: boolean
  tokens?: DiffTokens
  wrap: boolean
  query: string
  searchStep: number
  diff: IRawDiff
  selection: DiffSelection | null
  onChange?: (next: DiffSelection) => void
  onExpand?: (hunk: IRawDiff["hunks"][number], kind: "up" | "down") => void
  onContextLine?: (at: { line: number; hunk: number[] } | null) => void
}) {
  const { t } = useTranslation()
  const parent = useRef<HTMLDivElement>(null)
  const expansionRefs = useRef(new Map<string, HTMLButtonElement>())
  const lastExpanded = useRef<{ index: number; direction: DiffHunkExpansionType } | null>(null)
  const canExpand = !!onExpand
  // Desktop focusAfterLastExpandedHunkChange: same button, next, previous, then viewport.
  useLayoutEffect(() => {
    const last = lastExpanded.current
    if (!last || !canExpand) return
    lastExpanded.current = null
    const refs = expansionRefs.current
    const keys = [...refs.keys()].toSorted()
    const same = refs.get(`${last.index}-${last.direction}`)
    const next = keys.find(key => Number.parseInt(key.split("-")[0], 10) >= last.index)
    const previous = keys.toReversed().find(key => Number.parseInt(key.split("-")[0], 10) <= last.index)
    const target = same ?? refs.get(next ?? previous ?? "") ?? parent.current
    target?.focus()
  }, [diff, canExpand])
  const rows = useMemo(() => getDiffRows(toTextDiff(diff), split, !!onExpand), [diff, split, onExpand])
  const [temporarySelection, setTemporarySelection] = useState<{
    from: number
    to: number
    isSelected: boolean
  } | null>(null)
  const drag = useRef(temporarySelection)
  const pointer = useRef<{ clientX: number; clientY: number } | null>(null)
  const [hoveredHunk, setHoveredHunk] = useState<number | null>(null)
  const [selectingColumn, setSelectingColumn] = useState("before")
  const selectedText = () => {
    const selected = document.getSelection()
    if (!selected?.rangeCount || !parent.current?.contains(selected.getRangeAt(0).commonAncestorContainer)) return ""
    if (selected.getRangeAt(0).commonAncestorContainer !== parent.current) return selected.toString()
    // Desktop onCutOrCopy: select-all includes virtual rows that are not mounted.
    const exclude = split ? (selectingColumn === "before" ? DiffLineType.Add : DiffLineType.Delete) : false
    return diff.hunks
      .flatMap(hunk => hunk.lines.filter(line => line.type !== exclude).map(line => line.content))
      .join("\n")
  }
  const selectAllText = () => {
    parent.current?.focus()
    if (parent.current) document.getSelection()?.selectAllChildren(parent.current)
  }
  useEffect(() => {
    const viewport = parent.current
    if (!viewport) return
    const selectAll = (event: Event) => {
      event.preventDefault()
      viewport.focus()
      document.getSelection()?.selectAllChildren(viewport)
    }
    viewport.addEventListener("select-all", selectAll)
    return () => viewport.removeEventListener("select-all", selectAll)
  }, [])
  const lineAt = (index: number, column: DiffColumn) => {
    const row = rows[index]
    if (!row) return null
    if (row.type === DiffRowType.Added || row.type === DiffRowType.Deleted) return row.data.diffLineNumber
    if (row.type === DiffRowType.Modified)
      return (column === DiffColumn.Before ? row.beforeData : row.afterData).diffLineNumber
    return null
  }
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 20,
    overscan: 15
  })
  const matches = useMemo(() => {
    if (!query) return []
    const needle = query.toLocaleLowerCase()
    return rows.flatMap((row, index) => {
      const contents =
        row.type === DiffRowType.Modified
          ? [
              { content: row.beforeData.content, side: "oldTokens" },
              { content: row.afterData.content, side: "newTokens" }
            ]
          : row.type === DiffRowType.Added || row.type === DiffRowType.Deleted
            ? [{ content: row.data.content, side: row.type === DiffRowType.Added ? "newTokens" : "oldTokens" }]
            : row.type === DiffRowType.Context
              ? [{ content: row.content, side: "context" }]
              : []
      return contents.flatMap(({ content, side }) => {
        const found: { row: number; side: string; offset: number }[] = []
        const text = content.toLocaleLowerCase()
        for (let offset = text.indexOf(needle); offset >= 0; offset = text.indexOf(needle, offset + needle.length))
          found.push({ row: index, side, offset })
        return found
      })
    })
  }, [rows, query])
  const matchIndex = matches.length ? ((searchStep % matches.length) + matches.length) % matches.length : -1
  const currentMatch = matches[matchIndex]
  useEffect(() => {
    if (currentMatch) virtual.scrollToIndex(currentMatch.row, { align: "center" })
  }, [currentMatch, virtual])
  useEffect(() => {
    onSearchResults?.({ current: matchIndex + 1, total: matches.length })
  }, [matchIndex, matches.length, onSearchResults])
  // Desktop's temporary patch-line range, committed only on mouseup.
  const updateDrag = useEffectEvent((event: { clientX: number; clientY: number }) => {
    pointer.current = event
    if (!drag.current || !parent.current) return
    const rect = parent.current.getBoundingClientRect()
    const offset = event.clientY - rect.top + parent.current.scrollTop
    const item = virtual.getVirtualItemForOffset(Math.max(0, Math.min(offset, virtual.getTotalSize() - 1)))
    if (!item) return
    const line = lineAt(item.index, event.clientX <= rect.left + rect.width / 2 ? DiffColumn.Before : DiffColumn.After)
    virtual.scrollToIndex(item.index, { align: "auto" })
    if (line !== null) {
      drag.current = { ...drag.current, to: line }
      setTemporarySelection(drag.current)
    }
  })
  const endDrag = useEffectEvent(() => {
    const range = drag.current
    drag.current = null
    pointer.current = null
    setTemporarySelection(null)
    if (!range || !selection || !onChange) return
    let next = selection
    for (let line = Math.min(range.from, range.to); line <= Math.max(range.from, range.to); line++)
      next = next.withLineSelection(line, range.isSelected)
    onChange(next)
  })
  useEffect(() => {
    document.addEventListener("mousemove", updateDrag)
    document.addEventListener("mouseup", endDrag)
    const cancel = () => {
      drag.current = null
      setTemporarySelection(null)
    }
    window.addEventListener("blur", cancel)
    return () => {
      document.removeEventListener("mousemove", updateDrag)
      document.removeEventListener("mouseup", endDrag)
      window.removeEventListener("blur", cancel)
    }
  }, [])
  const isSelecting = temporarySelection !== null
  useEffect(() => {
    if (!isSelecting) return
    let frame = 0
    const autoScroll = () => {
      const node = parent.current
      const point = pointer.current
      if (node && point && drag.current) {
        const rect = node.getBoundingClientRect()
        const step = point.clientY < rect.top ? -20 : point.clientY > rect.bottom ? 20 : 0
        if (step) {
          node.scrollTop += step
          updateDrag(point)
        }
      }
      frame = requestAnimationFrame(autoScroll)
    }
    frame = requestAnimationFrame(autoScroll)
    return () => cancelAnimationFrame(frame)
  }, [isSelecting])
  // cancel a drag when its patch is replaced.
  useEffect(() => {
    drag.current = null
    pointer.current = null
    setTemporarySelection(null)
  }, [diff, split])
  // wrap changes invalidate measured row heights.
  useEffect(() => {
    virtual.measure()
  }, [wrap, virtual])
  const searchTokens = (content: string, row: number, side: string): ILineTokens => {
    const result: ILineTokens = {}
    if (!query) return result
    const text = content.toLocaleLowerCase()
    const needle = query.toLocaleLowerCase()
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      result[at] = {
        length: needle.length,
        token:
          currentMatch?.row === row && currentMatch.side === side && currentMatch.offset === at
            ? "search-result search-result-current"
            : "search-result"
      }
    }
    return result
  }
  const data = (d: SimplifiedDiffRowData, side: "oldTokens" | "newTokens", row: number) => {
    const syntax = getTokens(d.lineNumber, tokens?.[side])
    const line = d.diffLineNumber
    const inRange =
      line !== null &&
      temporarySelection &&
      line >= Math.min(temporarySelection.from, temporarySelection.to) &&
      line <= Math.max(temporarySelection.from, temporarySelection.to)
    return {
      ...d,
      tokens: [...d.tokens, ...(syntax === null ? [] : [syntax]), searchTokens(d.content, row, side)],
      isSelected: inRange ? temporarySelection.isSelected : line !== null && (selection?.isSelected(line) ?? false)
    }
  }
  const select = (index: number, column: DiffColumn, checked: boolean) => {
    const line = lineAt(index, column)
    if (line !== null && selection && onChange) onChange(selection.withLineSelection(line, checked))
  }
  const startSelection = (index: number, column: DiffColumn, isSelected: boolean) => {
    const line = lineAt(index, column)
    if (line === null || !selection || !onChange) return
    drag.current = { from: line, to: line, isSelected }
    setTemporarySelection(drag.current)
  }
  const groups = useMemo(() => {
    const result = new Map<number, { staticData: IRowSelectableGroup["staticData"]; from: number; to: number }>()
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      if (!isRowChanged(row) || result.has(row.hunkStartLine)) continue
      const start = index
      while (index + 1 < rows.length && isRowChanged(rows[index + 1])) index++
      const lineNumbers = new Set<number>()
      const lineNumbersIdentifiers: CheckBoxIdentifier[] = []
      let hasBefore = false
      let hasAfter = false
      for (const r of rows.slice(start, index + 1)) {
        if (r.type === DiffRowType.Added || r.type === DiffRowType.Modified) {
          const d = r.type === DiffRowType.Added ? r.data : r.afterData
          lineNumbers.add(d.lineNumber)
          lineNumbersIdentifiers.push(`${d.lineNumber}-after`)
          hasAfter = true
        }
        if (r.type === DiffRowType.Deleted || r.type === DiffRowType.Modified) {
          const d = r.type === DiffRowType.Deleted ? r.data : r.beforeData
          lineNumbers.add(d.lineNumber)
          lineNumbersIdentifiers.push(`${d.lineNumber}-before`)
          hasBefore = true
        }
      }
      const range = findInteractiveOriginalDiffRange(diff.hunks, row.hunkStartLine)
      if (range)
        result.set(row.hunkStartLine, {
          ...range,
          staticData: {
            diffRowStartIndex: start,
            diffRowStopIndex: index,
            diffType: hasBefore && hasAfter ? DiffRowType.Modified : hasAfter ? DiffRowType.Added : DiffRowType.Deleted,
            lineNumbers: [...lineNumbers].toSorted((a, b) => a - b),
            lineNumbersIdentifiers
          }
        })
    }
    return result
  }, [rows, diff])
  const groupFor = (index: number): IRowSelectableGroup | null => {
    const row = rows[index]
    if (!isRowChanged(row)) return null
    const group = groups.get(row.hunkStartLine)
    if (!group) return null
    const visible = virtual.getVirtualItems()
    const first = Math.max(group.staticData.diffRowStartIndex, visible[0]?.index ?? 0)
    return {
      staticData: group.staticData,
      isFirst: index === group.staticData.diffRowStartIndex,
      isCheckAllRenderedInRow: index === first,
      isHovered: hoveredHunk === row.hunkStartLine,
      selectionState: selection?.isRangeSelected(group.from, group.to - group.from + 1) ?? DiffSelectionType.None,
      height: visible
        .filter(item => item.index >= first && item.index <= group.staticData.diffRowStopIndex)
        .reduce((sum, item) => sum + item.size, 0)
    }
  }
  const context = (originalLine: number) => {
    const displayLine = diff.hunks.flatMap(h => h.lines).findIndex(line => line.originalLineNumber === originalLine)
    const range = findInteractiveOriginalDiffRange(diff.hunks, displayLine)
    onContextLine?.(
      range?.type != null
        ? {
            line: originalLine,
            hunk: Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i)
          }
        : null
    )
  }
  const contextHunk = (displayLine: number) => {
    const range = findInteractiveOriginalDiffRange(diff.hunks, displayLine)
    if (range) context(range.from)
    else onContextLine?.(null)
  }
  return (
    <div
      ref={parent}
      role="table"
      aria-label={t(split ? "diff.split" : "diff.unified")}
      aria-rowcount={rows.length}
      className={`side-by-side-diff-container min-h-0 flex-1 ${split ? "" : "unified-diff"} ${onChange ? "editable" : ""} ${split ? `selecting-${selectingColumn}` : ""} ${wrap ? "" : "no-wrap"}`}
      style={{ overflow: "auto", "--split-white-space": wrap ? "pre-wrap" : "pre" } as React.CSSProperties}
      // keyboard focus enables selecting text in the diff viewport.
      tabIndex={0}
      onCopy={event => {
        const text = selectedText()
        if (text) {
          event.preventDefault()
          event.clipboardData.setData("text/plain", text)
        }
      }}
      onContextMenuCapture={() => {
        onContextLine?.(null)
        onTextContext?.({ text: selectedText(), selectAll: selectAllText })
      }}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === "a") {
          event.preventDefault()
          selectAllText()
        }
        if (event.key === "Escape") {
          drag.current = null
          pointer.current = null
          setTemporarySelection(null)
        }
      }}
      onMouseDown={event => {
        if (!split) return
        if (!(event.target instanceof HTMLElement)) return
        if (event.target.closest(".before")) setSelectingColumn("before")
        else if (event.target.closest(".after")) setSelectingColumn("after")
      }}>
      <div
        className="side-by-side-diff"
        role="rowgroup"
        style={{ height: virtual.getTotalSize(), flexShrink: 0, position: "relative", width: "100%" }}>
        {virtual.getVirtualItems().map(item => {
          const row = rows[item.index]
          const decorated: DiffRow =
            row.type === DiffRowType.Modified
              ? {
                  ...row,
                  beforeData: data(row.beforeData, "oldTokens", item.index),
                  afterData: data(row.afterData, "newTokens", item.index)
                }
              : row.type === DiffRowType.Added || row.type === DiffRowType.Deleted
                ? {
                    ...row,
                    data: data(row.data, row.type === DiffRowType.Added ? "newTokens" : "oldTokens", item.index)
                  }
                : row.type === DiffRowType.Context
                  ? {
                      ...row,
                      beforeTokens: [
                        ...row.beforeTokens,
                        searchTokens(row.content, item.index, "context"),
                        getTokens(row.beforeLineNumber, tokens?.oldTokens) ??
                          getTokens(row.afterLineNumber, tokens?.newTokens) ??
                          {}
                      ],
                      afterTokens: [
                        ...row.afterTokens,
                        searchTokens(row.content, item.index, "context"),
                        getTokens(row.afterLineNumber, tokens?.newTokens) ??
                          getTokens(row.beforeLineNumber, tokens?.oldTokens) ??
                          {}
                      ]
                    }
                  : row
          return (
            <div
              key={item.key}
              role="row"
              aria-rowindex={item.index + 1}
              data-index={item.index}
              ref={virtual.measureElement}
              style={{ position: "absolute", top: 0, width: "100%", transform: `translateY(${item.start}px)` }}>
              <SideBySideDiffRow
                row={decorated}
                isDiffSelectable={!!onChange}
                showSideBySideDiff={split}
                hideWhitespaceInDiff={hideWhitespace}
                lineNumberWidth={getLineWidthFromDigitCount(getNumberOfDigits(diff.maxLineNumber))}
                numRow={item.index}
                onStartSelection={startSelection}
                onLineNumberCheckedChanged={select}
                onMouseEnterHunk={hunk => {
                  if (!drag.current) setHoveredHunk(hunk)
                }}
                onMouseLeaveHunk={() => setHoveredHunk(null)}
                onExpandHunk={(index, direction) => {
                  const hunk = diff.hunks[index]
                  if (hunk) {
                    lastExpanded.current = { index, direction }
                    onExpand?.(hunk, direction === DiffHunkExpansionType.Down ? "down" : "up")
                  }
                }}
                onClickHunk={(start, checked) => {
                  if (!selection || !onChange) return
                  const range = findInteractiveOriginalDiffRange(diff.hunks, start)
                  if (!range) return
                  let next = selection
                  for (let line = range.from; line <= range.to; line++) next = next.withLineSelection(line, checked)
                  onChange(next)
                }}
                onContextMenuLine={context}
                onContextMenuHunk={contextHunk}
                onContextMenuExpandHunk={() => onContextLine?.(null)}
                afterClassNames={[]}
                beforeClassNames={[]}
                onHideWhitespaceInDiffChanged={hide => onHideWhitespaceChange?.(hide)}
                onHunkExpansionRef={(index, direction, button) => {
                  const key = `${index}-${direction}`
                  if (button) expansionRefs.current.set(key, button)
                  else expansionRefs.current.delete(key)
                }}
                showDiffCheckMarks
                rowSelectableGroup={groupFor(item.index)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
