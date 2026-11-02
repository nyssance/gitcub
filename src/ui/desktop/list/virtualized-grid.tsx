import { observeElementOffset, useVirtualizer } from "@tanstack/react-virtual"
import clsx from "clsx"
import * as React from "react"

/**
 * Desktop's `List` and `SectionList` drive react-virtualized 10's single-column
 * `Grid`. This component keeps that contract (props, imperative handle, DOM
 * class names, cell styles and scroll semantics) on top of
 * `@tanstack/react-virtual` so the lists stay a verbatim port while the
 * unmaintained library is gone.
 *
 * Only the first column is ever rendered; both Desktop lists are single-column
 * and `columnCount` is accepted purely for prop compatibility.
 */

export type Alignment = "auto" | "center" | "end" | "start"

export type CellSize = number | ((params: { index: number }) => number)

export interface CellRendererParams {
  /** Horizontal (column) index of cell */
  readonly columnIndex: number
  /** The Grid is currently being scrolled */
  readonly isScrolling: boolean
  /** The cell is within the visible (non-overscan) area */
  readonly isVisible: boolean
  /** Unique key within array of cells */
  readonly key: React.Key
  /** Vertical (row) index of cell */
  readonly rowIndex: number
  /** Style object to be applied to cell */
  readonly style: React.CSSProperties
}

export interface ScrollParams {
  readonly clientHeight: number
  readonly clientWidth: number
  readonly scrollHeight: number
  readonly scrollLeft: number
  readonly scrollTop: number
  readonly scrollWidth: number
}

export interface GridProps {
  /** ARIA label for the grid element; react-virtualized defaults it to "grid". */
  readonly "aria-label"?: string
  readonly "aria-labelledby"?: string
  readonly "aria-multiselectable"?: boolean | "false" | "true"
  /** Defaults to true for grid roles only; list roles get no attribute. */
  readonly "aria-readonly"?: boolean
  /** Set the width of the inner scrollable container to 'auto' so a single column never extends below a vertical scrollbar. */
  readonly autoContainerWidth?: boolean
  readonly cellRenderer: (params: CellRendererParams) => React.ReactNode
  readonly className?: string
  readonly columnCount: number
  readonly columnWidth: CellSize
  /** Additional props spread onto the outer scrolling element. */
  readonly containerProps?: React.HTMLAttributes<HTMLDivElement>
  /** ARIA role for the inner cell container. */
  readonly containerRole?: string
  readonly containerStyle?: React.CSSProperties
  readonly height: number
  readonly id?: string
  readonly onScroll?: (params: ScrollParams) => void
  readonly overscanRowCount?: number
  readonly role?: string
  readonly rowCount: number
  readonly rowHeight: CellSize
  /** Milliseconds after the last scroll event before `isScrolling` resets. */
  readonly scrollingResetTimeInterval?: number
  /**
   * Controlled vertical offset. Desktop's wrapper re-applied it after every
   * parent render, which is what the passive per-section grids rely on.
   */
  readonly scrollTop?: number
  readonly style?: React.CSSProperties
  readonly tabIndex?: number | null
  readonly width: number
  readonly ref?: React.Ref<GridImperativeAPI>
}

/** Public (imperative) methods of a `Grid` (its ref handle). */
export interface GridImperativeAPI {
  /** Re-render the visible cells although the `Grid`'s props have not changed. */
  forceUpdate(): void
  /** Recompute row heights (and the total height) after `rowHeight` started returning different values. */
  recomputeGridSize(params?: { columnIndex?: number; rowIndex?: number }): void
  /**
   * Ensure the row is visible, scrolling the least amount possible for "auto";
   * a row taller than the `Grid` is aligned to its start. Nothing is scrolled
   * while the `Grid`'s width or height is 0.
   */
  scrollToCell(params: { align?: Alignment; columnIndex?: number; rowIndex?: number }): void
  /** Scroll to the offset, clamped to the scrollable range; the current offset is a no-op. */
  scrollToPosition(params: { scrollLeft?: number; scrollTop?: number }): void
}

function cellSize(size: CellSize, index: number) {
  return typeof size === "number" ? size : size({ index })
}

/** react-virtualized's `getUpdatedOffsetForIndex`. */
function updatedOffsetForCell(
  align: Alignment,
  cellOffset: number,
  size: number,
  containerSize: number,
  currentOffset: number
) {
  const maxOffset = cellOffset
  const minOffset = maxOffset - containerSize + size
  switch (align) {
    case "start":
      return maxOffset
    case "end":
      return minOffset
    case "center":
      return maxOffset - (containerSize - size) / 2
    default:
      return size >= containerSize ? maxOffset : Math.max(minOffset, Math.min(maxOffset, currentOffset))
  }
}

const noScroll = () => {}

export function Grid(props: GridProps) {
  const {
    "aria-label": ariaLabel = "grid",
    "aria-labelledby": ariaLabelledBy,
    "aria-multiselectable": ariaMultiselectable,
    "aria-readonly": ariaReadonly,
    autoContainerWidth = false,
    cellRenderer,
    className,
    columnCount,
    columnWidth,
    containerProps,
    containerRole = "row",
    containerStyle,
    height,
    id,
    onScroll,
    overscanRowCount = 10,
    ref,
    role = "grid",
    rowCount,
    rowHeight,
    scrollingResetTimeInterval = 150,
    scrollTop: controlledScrollTop,
    style,
    tabIndex = 0,
    width
  } = props

  const element = React.useRef<HTMLDivElement | null>(null)
  const latest = React.useRef({ height, onScroll, rowCount, rowHeight, width })
  latest.current = { height, onScroll, rowCount, rowHeight, width }
  const [, forceRender] = React.useReducer((value: number) => value + 1, 0)
  /** tanstack's offset subscriber; programmatic scrolls go through it so the virtualizer stays consistent. */
  const offsetListener = React.useRef<((offset: number, isScrolling: boolean) => void) | null>(null)
  /** Offset still to be written to the DOM after the next commit. */
  const requested = React.useRef<number | null>(null)
  const committed = React.useRef<{ height: number; rowCount: number; scrollTop: number } | null>(null)
  const emitted = React.useRef<number | null>(null)
  /** Current render's `emitScroll`, for the observer registered on the first render. */
  const emit = React.useRef<(scrollTop: number) => void>(() => {})
  const lastProps = React.useRef<GridProps | null>(null)

  const estimateSize = React.useCallback((index: number) => cellSize(latest.current.rowHeight, index), [])

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rowCount,
    estimateSize,
    getScrollElement: () => element.current,
    initialOffset: controlledScrollTop ?? 0,
    initialRect: { height, width },
    isScrollingResetDelay: scrollingResetTimeInterval,
    observeElementOffset: (instance, callback) => {
      offsetListener.current = callback
      const unsubscribe = observeElementOffset(instance, (offset, isScrolling) => {
        callback(offset, isScrolling)
        if (isScrolling) emit.current(offset)
      })
      return () => {
        offsetListener.current = null
        unsubscribe?.()
      }
    },
    // The size is a prop, exactly like react-virtualized: never measured from the DOM.
    observeElementRect: (_instance, callback) => {
      callback({ height: latest.current.height, width: latest.current.width })
    },
    overscan: overscanRowCount,
    scrollToFn: noScroll,
    // Let a scroll event's re-render batch with the consumer's own state updates.
    useFlushSync: false
  })

  /** tanstack initialises its offset lazily from `initialOffset`, which is the same value before the first layout. */
  const currentOffset = () => virtualizer.scrollOffset ?? controlledScrollTop ?? 0

  const columnsWidth = columnCount > 0 ? cellSize(columnWidth, 0) : 0

  const emitScroll = (scrollTop: number) => {
    if (emitted.current === scrollTop) return
    emitted.current = scrollTop
    latest.current.onScroll?.({
      clientHeight: latest.current.height,
      clientWidth: latest.current.width,
      scrollHeight: virtualizer.getTotalSize(),
      scrollLeft: 0,
      scrollTop,
      scrollWidth: columnsWidth
    })
  }
  emit.current = emitScroll

  const clampScrollTop = (scrollTop: number) =>
    Math.max(0, Math.min(scrollTop, Math.max(0, virtualizer.getTotalSize() - latest.current.height)))

  /** Programmatic scroll from the imperative handle or an effect. */
  const setScrollTop = (scrollTop: number) => {
    const next = clampScrollTop(scrollTop)
    if (next === currentOffset()) return
    requested.current = next
    if (offsetListener.current) offsetListener.current(next, false)
    else virtualizer.scrollOffset = next
    // react-virtualized always re-rendered after a requested scroll, which is
    // also what delivers `onScroll` for offsets that keep the same row range.
    forceRender()
  }

  const scrollToCell = (align: Alignment, rowIndex: number) => {
    const { height: containerSize, rowCount: count, width: containerWidth } = latest.current
    if (containerSize <= 0 || containerWidth <= 0 || rowIndex < 0) return
    const current = currentOffset()
    let calculated = 0
    if (count > 0) {
      const target = Math.min(count - 1, rowIndex)
      virtualizer.getTotalSize()
      const cell = virtualizer.measurementsCache[target]
      if (cell === undefined) return
      calculated = updatedOffsetForCell(align, cell.start, cell.size, containerSize, current)
    }
    if (calculated >= 0 && calculated !== current) setScrollTop(calculated)
  }

  // Props are a new object on every parent render and the same object on the
  // Grid's own re-renders, which is the distinction Desktop's wrapper made by
  // re-applying the controlled offset in an effect of its own.
  const parentRendered = lastProps.current !== props
  lastProps.current = props

  if (
    virtualizer.scrollRect !== null &&
    (virtualizer.scrollRect.width !== width || virtualizer.scrollRect.height !== height)
  )
    virtualizer.scrollRect = { height, width }

  if (controlledScrollTop !== undefined && parentRendered) {
    const next = clampScrollTop(controlledScrollTop)
    if (next !== currentOffset()) {
      virtualizer.scrollOffset = next
      requested.current = next
    }
  }

  const numericRowHeight = typeof rowHeight === "number" ? rowHeight : undefined
  const measuredRowHeight = React.useRef(numericRowHeight)
  React.useLayoutEffect(() => {
    if (measuredRowHeight.current === numericRowHeight) return
    measuredRowHeight.current = numericRowHeight
    virtualizer.measure()
  }, [numericRowHeight, virtualizer])

  /** Current render's scroll helpers, so the stable handle never calls a stale closure. */
  const scrolling = React.useRef({ scrollToCell, setScrollTop })
  scrolling.current = { scrollToCell, setScrollTop }

  React.useImperativeHandle(
    ref,
    () => ({
      forceUpdate: () => forceRender(),
      recomputeGridSize: () => virtualizer.measure(),
      scrollToCell: ({ align = "auto", rowIndex }) => {
        if (rowIndex !== undefined) scrolling.current.scrollToCell(align, rowIndex)
      },
      scrollToPosition: ({ scrollTop }) => {
        if (typeof scrollTop === "number" && !Number.isNaN(scrollTop)) scrolling.current.setScrollTop(scrollTop)
      }
    }),
    [virtualizer]
  )

  const scrollOffset = currentOffset()
  const totalHeight = virtualizer.getTotalSize()
  const isScrolling = virtualizer.isScrolling

  React.useLayoutEffect(() => {
    const node = element.current
    const previous = committed.current
    if (node !== null) {
      const target = previous === null ? scrollOffset : requested.current
      if (target !== null && node.scrollTop !== target) {
        node.scrollTop = target
        const actual = node.scrollTop
        if (Math.abs(actual - target) >= 1 && actual !== scrollOffset) offsetListener.current?.(actual, false)
      }
    }
    requested.current = null
    if (previous !== null && rowCount > 0 && (height < previous.height || rowCount < previous.rowCount)) {
      if (scrollOffset > totalHeight - height) scrollToCell("auto", rowCount - 1)
    } else if (rowCount === 0 && scrollOffset !== 0) {
      setScrollTop(0)
    }
    committed.current = { height, rowCount, scrollTop: scrollOffset }
    emitScroll(scrollOffset)
  })

  const children: React.ReactNode[] = []
  for (const item of virtualizer.getVirtualItems()) {
    const rendered = cellRenderer({
      columnIndex: 0,
      isScrolling,
      isVisible: item.end > scrollOffset && item.start < scrollOffset + height,
      key: `${item.index}-0`,
      rowIndex: item.index,
      style: { height: item.size, left: 0, position: "absolute", top: item.start, width: columnsWidth }
    })
    if (rendered === null || rendered === undefined || rendered === false) continue
    children.push(
      React.isValidElement<{ role?: string }>(rendered) && !rendered.props.role
        ? React.cloneElement(rendered, { role: "gridcell" })
        : rendered
    )
  }

  const gridStyle: React.CSSProperties = {
    boxSizing: "border-box",
    direction: "ltr",
    height,
    overflowX: columnsWidth <= width ? "hidden" : "auto",
    overflowY: totalHeight <= height ? "hidden" : "auto",
    position: "relative",
    WebkitOverflowScrolling: "touch",
    width,
    willChange: "transform"
  }

  return (
    <div
      ref={element}
      {...containerProps}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-multiselectable={ariaMultiselectable}
      aria-readonly={ariaReadonly ?? (role === "grid" || role === "treegrid" ? true : undefined)}
      className={clsx("ReactVirtualized__Grid", className)}
      id={id}
      role={role}
      style={{ ...gridStyle, ...style }}
      tabIndex={tabIndex ?? undefined}>
      {children.length > 0 && (
        <div
          className="ReactVirtualized__Grid__innerScrollContainer"
          role={containerRole}
          style={{
            width: autoContainerWidth ? "auto" : columnsWidth,
            height: totalHeight,
            maxWidth: columnsWidth,
            maxHeight: totalHeight,
            overflow: "hidden",
            pointerEvents: isScrolling ? "none" : undefined,
            position: "relative",
            ...containerStyle
          }}>
          {children}
        </div>
      )}
    </div>
  )
}
