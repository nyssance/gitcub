// Desktop MIT port; platform imports adapted to Tauri.

import classNames from "classnames"
import * as React from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import { createObservableRef } from "../../lib/ui/observable-ref"
import { Tooltip, TooltipDirection } from "../desktop/tooltip"
import type { OcticonSymbol, OcticonSymbolVariant } from "./octicons.generated"

interface IOcticonProps {
  /**
   * An instance of an object conforming to the OcticonSymbol type. Supports
   * custom paths as well as those provided through the static properties of
   * the OcticonSymbol class.
   */
  readonly symbol: OcticonSymbol

  /**
   * An optional classname that will be appended to the default
   * class name 'octicon'
   */
  readonly className?: string

  /**
   * An optional string to use as a tooltip and aria-label for the icon
   */
  readonly title?: string

  readonly tooltipDirection?: TooltipDirection

  readonly height?: number
}

/**
 * A React component for displaying octicon symbols in SVG format.
 *
 * Note that the aspect ratios of the octicons will always be preserved
 * which is why the width and height properties specify the maximum and
 * not the minimum size.
 *
 * Usage: `<Octicon symbol={octicons.markGithub} />`
 */
// Preserve the original Desktop component contract.
export class Octicon extends React.Component<IOcticonProps, Record<string, never>> {
  private svgRef = createObservableRef<SVGSVGElement>()

  public render() {
    const { symbol } = this.props

    if (this.isSingleVariant(symbol)) {
      return this.renderIcon(symbol.p, symbol.h, symbol.w)
    } else {
      const height = this.props.height ?? 16
      const naturalHeight = this.closestNaturalHeight(
        Object.keys(symbol).map(h => Number.parseInt(h, 10)) as Array<number>,
        height
      )

      const scaledSymbol = symbol[naturalHeight]

      if (scaledSymbol === undefined) {
        // Should never happen, but if it does the app should still be usable
        return null
      }

      const naturalWidth = scaledSymbol.w
      const width = height * (naturalWidth / naturalHeight)

      return this.renderIcon(scaledSymbol.p, height, width)
    }
  }

  private renderIcon(paths: string[], height: number, width: number) {
    const { title, tooltipDirection } = this.props
    const viewBox = `0 0 ${width} ${height}`
    const className = classNames("octicon", this.props.className)

    // Hide the octicon from screen readers when it's only being used
    // as a visual without any attached meaning applicable to users
    // consuming the app through an accessibility interface.
    const ariaHidden = title === undefined ? "true" : undefined

    // Octicons are typically very small so having an explicit direction makes
    // more sense
    const direction = tooltipDirection ?? TooltipDirection.NORTH

    return (
      <svg
        aria-hidden={ariaHidden}
        aria-label={title}
        className={className}
        fill="currentColor"
        version="1.1"
        viewBox={viewBox}
        ref={this.svgRef}
        tabIndex={-1}
        height={height}
        width={width}>
        {title !== undefined && (
          <Tooltip target={this.svgRef} direction={direction} applyAriaDescribedBy={false}>
            {title}
          </Tooltip>
        )}

        {paths.map((d, i) => (
          // Preserve the original Desktop component contract.
          <path key={i} d={d} />
        ))}
      </svg>
    )
  }

  /**
   * Determine if the given symbol is a single variant or a set of variants.
   *
   * @param symbol The symbol to check.
   * @returns      True if the symbol is a single variant, false if it's a set.
   */
  private isSingleVariant(symbol: OcticonSymbol): symbol is OcticonSymbolVariant {
    return (
      // Preserve the original Desktop component contract.
      symbol instanceof Object && Object.hasOwn(symbol, "p") && Object.hasOwn(symbol, "h") && Object.hasOwn(symbol, "w")
    )
  }

  /**
   * Find the closest natural height to the given height. Falls back to the
   * first height in the list if none are larger or equal than the given height.
   *
   * @param naturalHeights The list of natural heights to choose from.
   * @param height         The height to find the closest natural height to.
   * @returns              The closest natural height to the given height.
   */
  private closestNaturalHeight(naturalHeights: Array<number>, height: number) {
    return naturalHeights.reduce(
      (acc, naturalHeight) => (naturalHeight <= height ? naturalHeight : acc),
      naturalHeights[0]
    )
  }
}

/**
 * Create an Octicon element for the DOM, wrapped in a div element.
 *
 * @param symbol    OcticonSymbol to render in the element.
 * @param className Optional class to add to the wrapper element.
 * @param id        Optional identifier to set to the wrapper element.
 */
export function createOcticonElement(symbol: OcticonSymbol, className?: string, id?: string) {
  const wrapper = document.createElement("div")
  wrapper.id = id ?? ""
  if (className !== undefined) {
    wrapper.classList.add(className)
  }
  const octicon = <Octicon symbol={symbol} />
  flushSync(() => createRoot(wrapper).render(octicon))
  return wrapper
}
