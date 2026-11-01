// Desktop MIT port; platform imports adapted to Tauri.

import classNames from "classnames"
import * as React from "react"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TabBarType } from "./tab-bar-type"

interface ITabBarItemProps {
  readonly grouped?: boolean
  readonly index: number
  readonly selected: boolean
  readonly onClick: (index: number) => void
  readonly onMouseEnter: (index: number) => void
  readonly onMouseLeave: () => void
  readonly onSelectAdjacent: (direction: "next" | "previous", index: number) => void
  readonly onButtonRef: (index: number, button: HTMLButtonElement | null) => void
  readonly type?: TabBarType
}

// Preserve the original Desktop component contract.
export class TabBarItem extends React.Component<React.PropsWithChildren<ITabBarItemProps>, Record<string, never>> {
  private onClick = (_event: React.MouseEvent<HTMLButtonElement>) => {
    this.props.onClick(this.props.index)
  }

  private onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const { type, index } = this.props
    const previousKey = type === TabBarType.Vertical ? "ArrowUp" : "ArrowLeft"
    const nextKey = type === TabBarType.Vertical ? "ArrowDown" : "ArrowRight"
    if (event.key === previousKey) {
      this.props.onSelectAdjacent("previous", index)
      event.preventDefault()
      event.stopPropagation()
    } else if (event.key === nextKey) {
      this.props.onSelectAdjacent("next", index)
      event.preventDefault()
      event.stopPropagation()
    }
  }

  private onButtonRef = (buttonRef: HTMLButtonElement | null) => {
    this.props.onButtonRef(this.props.index, buttonRef)
  }

  private onMouseEnter = () => {
    this.props.onMouseEnter(this.props.index)
  }

  public render() {
    const selected = this.props.selected
    const className = classNames("tab-bar-item", { selected })
    const item = (
      <TabsTrigger
        value={this.props.index}
        ref={this.onButtonRef}
        className={className}
        onClick={this.onClick}
        role="tab"
        aria-selected={selected}
        tabIndex={selected ? undefined : -1}
        onKeyDown={this.onKeyDown}
        onMouseEnter={this.onMouseEnter}
        onMouseLeave={this.props.onMouseLeave}
        type="button">
        {this.props.children}
      </TabsTrigger>
    )
    return this.props.grouped ? (
      item
    ) : (
      <Tabs value={selected ? this.props.index : null}>
        <TabsList activateOnFocus={false}>{item}</TabsList>
      </Tabs>
    )
  }
}
