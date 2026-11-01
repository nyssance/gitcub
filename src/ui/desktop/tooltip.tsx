// Desktop target-ref compatibility; rendering and positioning use shadcn/Base UI.
import * as React from "react"

import type { ObservableRef } from "../../lib/ui/observable-ref"
import { cn } from "../../lib/utils"
import { Tooltip as StandardTooltip, TooltipContent } from "@/components/ui/tooltip"
export enum TooltipDirection {
  NORTH = "n",
  NORTH_EAST = "ne",
  EAST = "e",
  SOUTH_EAST = "se",
  SOUTH = "s",
  SOUTH_WEST = "sw",
  WEST = "w",
  NORTH_WEST = "nw"
}

export type TooltipTarget = Element & GlobalEventHandlers

export interface ITooltipProps<T> {
  /**
   * The target element for which to display a tooltip. Use
   * `createObservableRef` to create an `ObservableRef`. Note that
   * `ObservablRef` is compatible with `React.Ref`
   */
  readonly target: ObservableRef<T>

  /**
   * Whether or not to modify the target element when the tooltip is showing to
   * add the necessary `aria-` attributes for accessibility. It's not
   * recommended to disable this unless the target element is already adequately
   * described by `aria-label`.
   *
   * Defaults to true
   */
  readonly accessible?: boolean

  /**
   * Whether or not the tooltip should remain open when the user moves their
   * pointer device from the target onto the tooltip itself. Non interactive
   * tooltips are not pointer event targets.
   */
  readonly interactive?: boolean

  /**
   * Whether or not the tooltip should be dismissable via the escape key. This
   * is generally true, but if the tooltip is communicating something important
   * to the user, such as an input error, it should not be dismissable.
   *
   * Defaults to true
   */
  readonly dismissable?: boolean

  /**
   * The amount of time to wait (in milliseconds) while a user hovers over the
   * target before displaying the tooltip. There's typically no reason to
   * increase this but it may be used to show the tooltip without any delay (by
   * setting it to zero)
   *
   * Defaults to 400ms
   */
  readonly delay?: number

  /**
   * The desired position of the tooltip in relation to the target (cardinal
   * directions). Note that the tooltip will attempt to honor the desired
   * direction but if there's not enough room to place the tooltip in said
   * direction it will be repositioned automatically.
   *
   * When no direction has been specified the tooltip is automatically
   * positioned relative to the pointer coordinates.
   */
  readonly direction?: TooltipDirection

  /**
   * An optional additional class name to set on the tooltip in order to be able
   * to apply specific styles to the tooltip
   */
  readonly className?: string

  /**
   * Whether to only show the tooltip when the tooltip target overflows its
   * bounds. Typically this is used in conjunction with an ellipsis CSS ruleset.
   */
  readonly onlyWhenOverflowed?: boolean

  /**
   * Optional, custom overrided of the Tooltip components internal logic for
   * determining whether the tooltip target is overflowed or not.
   *
   * The internal overflow logic is simple and relies on the target itself
   * having the `text-overflow` CSS rule applied to it. In some scenarios
   * consumers may have a deep child element which is the one that should be
   * tested for overflow while still having the parent element be the pointer
   * device hit area.
   *
   * Consumers may pass a boolean if the overflowed state is known at render
   * time or they may pass a function which gets executed just before showing
   * the tooltip.
   */
  readonly isTargetOverflowed?: ((target: TooltipTarget) => boolean) | boolean

  /**
   * Optional parameter to be able offset the position of the target element
   * relative to the window. This can be useful in scenarios where the target's
   * natural positioning is not already relative to the window such as an
   * element within in iframe.
   */
  readonly tooltipOffset?: DOMRect

  /** Optional parameter for toggle tip behavior.
   *
   * This means that on target click
   * the tooltip will be shown but not on target focus.
   */
  readonly isToggleTip?: boolean

  /** Optional parameter for to open on target click
   *
   * If you are looking for toggle tip behavior (tooltip does not open on
   * focus), use isToggleTip instead.
   */
  readonly openOnTargetClick?: boolean

  /** Open on target focus - typically only tooltips that target an element with
   * ":focus-visible open on focus. This means any time the target it focused it
   * opens." */
  readonly openOnFocus?: boolean

  /** Whether or not an ancestor component is focused, used in case we want
   * the tooltip to be shown when it's focused. Examples of this are how we
   * want to show the tooltip for file status icons when files in the file
   * list are focused.
   */
  readonly ancestorFocused?: boolean

  /** Whether or not to apply the aria-desribedby to the target element.
   *
   * Sometimes the target element maybe something like a button that already has
   * an aria label that is the same as the tooltip content, if so this should be
   * false.
   *
   * Note: If the tooltip does provide more context than the targets accessible
   * label (visual or aria), this should be true.
   *
   * Default: true
   * */
  readonly applyAriaDescribedBy?: boolean

  /** Usually the position of the tooltip is relative to the mouse pointer, this
   * forces it to be relative to the target's position. Useful for tooltips
   * rendered by keyboard focus of the item. */
  readonly positionRelativeToTarget?: boolean

  /** Whether to show the tooltip when the target is focused */
  readonly disabled?: boolean
}

export function Tooltip<T extends TooltipTarget>(props: React.PropsWithChildren<ITooltipProps<T>>) {
  const [target, setTarget] = React.useState<T | null>(props.target.current)
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hide = React.useCallback(() => {
    clearTimeout(timer.current)
    setOpen(false)
  }, [])
  const show = React.useEffectEvent((delay = props.delay ?? 400) => {
    if (!target || props.disabled) return
    const overflow =
      typeof props.isTargetOverflowed === "function"
        ? props.isTargetOverflowed(target)
        : (props.isTargetOverflowed ??
          (target.scrollWidth > target.clientWidth || target.scrollHeight > target.clientHeight))
    if (props.onlyWhenOverflowed && !overflow) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), delay)
  })
  React.useEffect(() => {
    setTarget(props.target.current)
    props.target.subscribe(setTarget)
    return () => props.target.unsubscribe(setTarget)
  }, [props.target])
  React.useEffect(() => {
    if (!target) return
    const enter = () => {
      if (!props.isToggleTip) show()
    }
    const focus = () => {
      if (!props.isToggleTip && (props.openOnFocus || target.matches(":focus-visible"))) show(0)
    }
    const click = () => {
      if (props.isToggleTip || props.openOnTargetClick) show(0)
    }
    const leave = () => {
      clearTimeout(timer.current)
      if (props.interactive) timer.current = setTimeout(hide, 250)
      else hide()
    }
    target.addEventListener("mouseenter", enter)
    target.addEventListener("mouseleave", leave)
    target.addEventListener("focus", focus)
    target.addEventListener("blur", hide)
    target.addEventListener("click", click)
    return () => {
      clearTimeout(timer.current)
      target.removeEventListener("mouseenter", enter)
      target.removeEventListener("mouseleave", leave)
      target.removeEventListener("focus", focus)
      target.removeEventListener("blur", hide)
      target.removeEventListener("click", click)
    }
  }, [target, props.isToggleTip, props.openOnFocus, props.openOnTargetClick, props.interactive, hide])
  React.useEffect(() => {
    if (props.ancestorFocused) show(0)
    else hide()
  }, [props.ancestorFocused, hide])
  React.useEffect(() => {
    if (!open || !target || props.accessible === false || props.applyAriaDescribedBy === false) return
    const previous = target.getAttribute("aria-describedby")
    target.setAttribute("aria-describedby", [previous, id].filter(Boolean).join(" "))
    return () => {
      if (previous === null) target.removeAttribute("aria-describedby")
      else target.setAttribute("aria-describedby", previous)
    }
  }, [open, target, id, props.accessible, props.applyAriaDescribedBy])
  const direction = props.direction ?? TooltipDirection.NORTH
  const side = direction.startsWith("n")
    ? "top"
    : direction.startsWith("s")
      ? "bottom"
      : direction === "e"
        ? "right"
        : "left"
  const align =
    direction.endsWith("e") && direction.length > 1
      ? "end"
      : direction.endsWith("w") && direction.length > 1
        ? "start"
        : "center"
  if (!target || !open || props.disabled) return null
  return (
    <StandardTooltip
      open={open && !props.disabled}
      onOpenChange={(next, details) => {
        if (!next && props.dismissable === false && details.reason === "escape-key") {
          details.cancel()
          return
        }
        setOpen(next)
      }}>
      <TooltipContent
        id={id}
        anchor={target}
        side={side}
        align={align}
        role="tooltip"
        className={cn("tooltip", props.className)}
        onMouseEnter={() => {
          if (props.interactive) clearTimeout(timer.current)
        }}
        onMouseLeave={() => {
          if (props.interactive) hide()
        }}
        onClick={event => event.stopPropagation()}>
        <span className="tooltip-content">{props.children}</span>
      </TooltipContent>
    </StandardTooltip>
  )
}
