// Desktop call contract; positioning, focus and dismissal use Base UI.
// Desktop anchors to any element, not a trigger, which the shadcn PopoverContent cannot express,
// so this composes the Base UI parts directly with the shadcn popover-content styles.
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import type * as React from "react"

import { cn } from "../../lib/utils"
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
    <PopoverPrimitive.Root
      data-slot="popover"
      open
      modal={props.trapFocus !== false}
      onOpenChange={(open, details) => {
        if (!open)
          (props.onMousedownOutside ?? props.onClickOutside)?.(
            details.event instanceof MouseEvent ? details.event : undefined
          )
      }}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={props.anchor}
          side={side as "top" | "bottom" | "left" | "right"}
          align={align}
          sideOffset={props.anchorOffset ?? 4}
          className="isolate z-50">
          <PopoverPrimitive.Popup
            data-slot="popover-content"
            // Desktop 只在 trapFocus 时启用 FocusTrap；否则焦点留在原处（补全弹层不能把输入框的焦点抢走）
            initialFocus={props.trapFocus !== false}
            finalFocus={props.trapFocus !== false}
            role={props.isDialog === false ? undefined : "dialog"}
            aria-labelledby={props.ariaLabelledby}
            aria-describedby={props.ariaDescribedBy}
            className={cn(
              "z-50 flex w-72 origin-(--transform-origin) flex-col gap-4 rounded-md bg-popover p-4 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              "popover-component max-w-[calc(100vw-1.25rem)] overflow-y-auto",
              props.className
            )}
            style={{ minHeight: props.minHeight, maxHeight: props.maxHeight, ...props.style }}>
            {props.children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
