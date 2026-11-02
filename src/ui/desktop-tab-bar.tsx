// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { dragAndDropManager } from "../lib/drag-and-drop-manager"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList } from "@/components/ui/tabs"
import { TabBarItem } from "./tab-bar-item"
import { TabBarType } from "./tab-bar-type"

export { TabBarType } from "./tab-bar-type"

/** Time to wait for drag element hover before switching tabs */
const dragTabSwitchWaitTime = 500

interface ITabBarProps {
  /** The currently selected tab. */
  readonly selectedIndex: number

  /** A function which is called when a tab is clicked on. */
  readonly onTabClicked: (index: number) => void

  /** The type of TabBar controlling its style */
  readonly type?: TabBarType

  /** Navigate via drag over */
  readonly allowDragOverSwitching?: boolean
}

/**
 * The tab bar component.
 *
 * Set `children` to an array of JSX.Elements to represent the tab bar items.
 */
// Preserve the original Desktop component contract.
export class TabBar extends React.Component<React.PropsWithChildren<ITabBarProps>, Record<string, never>> {
  private readonly tabRefsByIndex = new Map<number, HTMLButtonElement>()
  private mouseOverTimeoutId: number | null = null

  public render() {
    const { type } = this.props

    return (
      <Tabs value={this.props.selectedIndex} orientation={type === TabBarType.Vertical ? "vertical" : "horizontal"}>
        <TabsList
          activateOnFocus={false}
          variant={type === TabBarType.Switch ? "default" : "line"}
          className={`tab-bar ${type === TabBarType.Switch ? "switch" : type === TabBarType.Vertical ? "vertical" : "tabs"}`}>
          {this.renderItems()}
        </TabsList>
      </Tabs>
    )
  }

  private onSelectAdjacentTab = (direction: "next" | "previous", index: number) => {
    const children = React.Children.toArray(this.props.children)

    if (children.length === 0) {
      return
    }

    const delta = direction === "next" ? 1 : -1

    // http://javascript.about.com/od/problemsolving/a/modulobug.htm
    const nextTabIndex = (index + delta + children.length) % children.length

    const button = this.tabRefsByIndex.get(nextTabIndex)

    if (button) {
      button.focus()
    }

    this.props.onTabClicked(nextTabIndex)
  }

  private onTabClicked = (index: number) => {
    this.props.onTabClicked(index)
  }

  private onTabRef = (index: number, ref: HTMLButtonElement | null) => {
    if (!ref) {
      this.tabRefsByIndex.delete(index)
    } else {
      this.tabRefsByIndex.set(index, ref)
    }
  }

  /**
   * If something is being dragged, this allows for tab selection by hovering
   * over a tab for a few seconds (dragTabSwitchWaitTime)
   */
  private onMouseEnter = (index: number) => {
    if (
      index === this.props.selectedIndex ||
      !dragAndDropManager.isDragInProgress ||
      this.props.allowDragOverSwitching === undefined ||
      !this.props.allowDragOverSwitching
    ) {
      return
    }

    this.mouseOverTimeoutId = window.setTimeout(() => {
      this.onTabClicked(index)
    }, dragTabSwitchWaitTime)
  }

  private onMouseLeave = () => {
    if (this.mouseOverTimeoutId !== null) {
      window.clearTimeout(this.mouseOverTimeoutId)
    }
  }

  private renderItems() {
    const { type, selectedIndex } = this.props
    const children = React.Children.toArray(this.props.children)

    return children.map((child, index) => {
      const selected = index === selectedIndex
      return (
        // Preserve the original Desktop component contract.
        <React.Fragment key={index}>
          <TabBarItem
            grouped
            selected={selected}
            index={index}
            onClick={this.onTabClicked}
            onMouseEnter={this.onMouseEnter}
            onMouseLeave={this.onMouseLeave}
            onSelectAdjacent={this.onSelectAdjacentTab}
            onButtonRef={this.onTabRef}
            type={type}>
            {child}
          </TabBarItem>
          {type === TabBarType.Switch && index < children.length - 1 && (
            <Separator orientation="vertical" className="tab-bar-separator" />
          )}
        </React.Fragment>
      )
    })
  }
}
