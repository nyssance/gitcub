// Desktop MIT port (ui/resizable/resizable.tsx); class component rewritten as a function component.
import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef, useState } from "react"

import { clamp } from "../../lib/clamp"
import { AriaLiveContainer } from "../accessibility/aria-live-container"

export const DefaultMaxWidth = 350
export const DefaultMinWidth = 200

/** This class is assigned to the containing div of the element and used in
 * determining whether the resizable is focused. */
export const resizableComponentClass = "resizable-component"

export enum ResizeDirection {
  Increase = "Increase",
  Decrease = "Decrease"
}

export interface IResizableProps {
  readonly width: number

  /** The maximum width the panel can be resized to.
   *
   * @default 350
   */
  readonly maximumWidth?: number

  /**
   * The minimum width the panel can be resized to.
   *
   * @default 150
   */
  readonly minimumWidth?: number

  /** The optional ID for the root element. */
  readonly id?: string

  /** Used to describe which resizable was updated to screen reader users */
  readonly description: string

  /**
   * Handler called when the width of the component has changed
   * through an explicit resize event (dragging the handle).
   */
  readonly onResize: (newWidth: number) => void

  /**
   * Handler called when the resizable component has been
   * reset (ie restored to its original width by double clicking
   * on the resize handle).
   */
  readonly onReset: () => void

  readonly children?: ReactNode
}

/**
 * Constrains the provided width to lie within the minimum and
 * maximum widths as determined by props
 */
function clampWidthFor(props: IResizableProps, width: number) {
  const { minimumWidth: min, maximumWidth: max } = props
  return clamp(width, min ?? DefaultMinWidth, max ?? DefaultMaxWidth)
}

function resizeMessageFor(props: IResizableProps, direction: ResizeDirection) {
  // getCurrentWidth: the width from props, constrained by the minimum and maximum widths
  const minWidth = props.minimumWidth ?? 0
  const maxWidth = props.maximumWidth ?? DefaultMaxWidth
  const percentage = Math.round(((clampWidthFor(props, props.width) - minWidth) / (maxWidth - minWidth)) * 100)
  const directionMessage = direction === ResizeDirection.Increase ? "increased" : "decreased"
  return `${props.description} width ${directionMessage}. Set to ${percentage}%`
}

/**
 * Component abstracting a resizable panel.
 *
 * Note: this component is pure, consumers must subscribe to the
 * onResize and onReset event and update the width prop accordingly.
 */
export function Resizable(props: IResizableProps) {
  const { width, maximumWidth, minimumWidth, id, onReset, children } = props
  const [resizeMessage, setResizeMessage] = useState("")
  const container = useRef<HTMLDivElement>(null)
  // The menu events and the document drag listeners outlive a render; read the latest props.
  const latest = useRef(props)
  latest.current = props

  const clampWidth = (value: number) => clampWidthFor(latest.current, value)
  const updateResizeMessage = (direction: ResizeDirection) =>
    setResizeMessage(resizeMessageFor(latest.current, direction))

  /**
   * Handler for when the user presses the mouse button over the resize
   * handle.
   */
  const handleDragStart = (e: ReactMouseEvent) => {
    const startX = e.clientX
    const startWidth = clampWidth(latest.current.width)

    /** Handler for when the user moves the mouse while dragging */
    const handleDragMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startX
      const newWidth = startWidth + deltaX

      updateResizeMessage(deltaX > 0 ? ResizeDirection.Increase : ResizeDirection.Decrease)
      latest.current.onResize(clampWidth(newWidth))
      e.preventDefault()
    }

    /**
     * Handler for when the user lets go of the mouse button during
     * a resize operation.
     */
    const handleDragStop = (e: MouseEvent) => {
      document.removeEventListener("mousemove", handleDragMove)
      document.removeEventListener("mouseup", handleDragStop)
      e.preventDefault()
    }

    document.addEventListener("mousemove", handleDragMove)
    document.addEventListener("mouseup", handleDragStop)

    e.preventDefault()
  }

  /**
   * Adds and removes listeners for custom events fired when user users keyboard
   * to resize the active resizable
   */
  useEffect(() => {
    const ref = container.current
    if (!ref) return
    /**
     * Handler for when a user uses keyboard shortcuts to resize the size the
     * active resizable
     */
    const handleMenuResizeEvent = (resizeDirection: ResizeDirection) => {
      const { width } = latest.current
      const changedWidth = resizeDirection === ResizeDirection.Decrease ? width - 5 : width + 5

      const newWidth = clampWidthFor(latest.current, changedWidth)

      setResizeMessage(resizeMessageFor(latest.current, resizeDirection))
      latest.current.onResize(clampWidthFor(latest.current, newWidth))
    }
    const increase = (ev: Event) => {
      handleMenuResizeEvent(ResizeDirection.Increase)
      ev.preventDefault()
    }
    const decrease = (ev: Event) => {
      handleMenuResizeEvent(ResizeDirection.Decrease)
      ev.preventDefault()
    }
    ref.addEventListener("increase-active-resizable-width", increase)
    ref.addEventListener("decrease-active-resizable-width", decrease)
    return () => {
      ref.removeEventListener("increase-active-resizable-width", increase)
      ref.removeEventListener("decrease-active-resizable-width", decrease)
    }
    // the helpers read the latest props through the ref
  }, [])

  const style = {
    width: clamp(width, minimumWidth ?? DefaultMinWidth, maximumWidth ?? DefaultMaxWidth),
    maxWidth: maximumWidth,
    minWidth: minimumWidth
  }

  return (
    <div id={id} className={resizableComponentClass} style={style} ref={container}>
      {children}
      <button
        // Prevent form submission with this button
        type="button"
        tabIndex={-1}
        onMouseDown={handleDragStart}
        onDoubleClick={onReset}
        className="resize-handle"
        aria-label="Resize handle"
      />
      <AriaLiveContainer message={resizeMessage} trackedUserInput={resizeMessage} />
    </div>
  )
}
