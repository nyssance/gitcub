// Desktop call contract; positioning, focus and dismissal use shadcn/Base UI.
import type * as React from "react"

import { cn } from "../../lib/utils"
import { Popover as StandardPopover, PopoverContent } from "../base/popover"
export enum PopoverAnchorPosition {
  Top = "top",
  TopRight = "top-right",
  TopLeft = "top-left",
  Left = "left",
  LeftTop = "left-top",
  LeftBottom = "left-bottom",
  Bottom = "bottom",
  BottomLeft = "bottom-left",
  BottomRight = "bottom-right",
  Right = "right",
  RightTop = "right-top",
  RightBottom = "right-bottom"
}

export enum PopoverAppearEffect {
  Shake = "shake"
}

export enum PopoverDecoration {
  None = "none",
  Bordered = "bordered",
  Balloon = "balloon"
}

export const PopoverScreenBorderPadding = 10
interface IPopoverProps {
  readonly onClickOutside?: (event?: MouseEvent) => void
  readonly onMousedownOutside?: (event?: MouseEvent) => void
  /** Element to anchor the popover to */
  readonly anchor: HTMLElement | null
  /** Offset to apply to the distance from the anchor */
  readonly anchorOffset?: number
  /** The position of the popover relative to the anchor.  */
  readonly anchorPosition: PopoverAnchorPosition
  /** Whether or not the popover behaves as a dialog. Optional. Default: true */
  readonly isDialog?: boolean
  /**
   * The position of the tip or pointer of the popover relative to the side at
   * which the tip is presented. Optional. Default: Center
   */
  readonly className?: string
  readonly style?: React.CSSProperties
  readonly appearEffect?: PopoverAppearEffect
  readonly ariaLabelledby?: string
  readonly ariaDescribedBy?: string
  readonly trapFocus?: boolean // Default: true
  readonly decoration?: PopoverDecoration // Default: none

  /** Maximum height decided by clients of Popover */
  readonly maxHeight?: number
  /** Minimum height decided by clients of Popover */
  readonly minHeight?: number
}

export function Popover(props: React.PropsWithChildren<IPopoverProps>) {
  const [side, edge] = props.anchorPosition.split("-")
  const align = edge === "left" || edge === "top" ? "start" : edge === "right" || edge === "bottom" ? "end" : "center"
  return (
    <StandardPopover
      open
      modal={props.trapFocus !== false}
      onOpenChange={(open, details) => {
        if (!open)
          (props.onMousedownOutside ?? props.onClickOutside)?.(
            details.event instanceof MouseEvent ? details.event : undefined
          )
      }}>
      <PopoverContent
        anchor={props.anchor}
        side={side as "top" | "bottom" | "left" | "right"}
        align={align}
        sideOffset={props.anchorOffset ?? 4}
        role={props.isDialog === false ? undefined : "dialog"}
        aria-labelledby={props.ariaLabelledby}
        aria-describedby={props.ariaDescribedBy}
        className={cn("popover-component max-w-[calc(100vw-1.25rem)] overflow-y-auto", props.className)}
        style={{ minHeight: props.minHeight, maxHeight: props.maxHeight, ...props.style }}>
        {props.children}
      </PopoverContent>
    </StandardPopover>
  )
}
