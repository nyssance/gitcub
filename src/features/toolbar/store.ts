/**
 * Toolbar Store —— 工具栏「当前分支」「推送／拉取」两格的宽度。
 *
 * 照原版 app-store：默认 230px，拖动后存 localStorage（同样的键），双击把手恢复默认；
 * 上下限按 updateResizableConstraints 的工具栏部分算。原版的可用宽度是窗口宽减左栏，
 * 这里工具栏只在工作区右列，可用宽度就是工具栏本身的宽度。
 */
import { create } from "zustand"

import { clamp } from "@/lib/clamp"
import type { IConstrainedValue } from "@/models/constrained-value"
import { getNumber, setNumber } from "@/upstream/lib/local-storage"

const defaultBranchDropdownWidth: number = 230
const branchDropdownWidthConfigKey: string = "branch-dropdown-width"

const defaultPushPullButtonWidth: number = 230
const pushPullButtonWidthConfigKey: string = "push-pull-button-width"

/** 原版 app-store.ts 的 constrain：min-width 优先于 max-width，与 CSS 一致。 */
function constrain(value: IConstrainedValue | number, min = -Infinity, max = Infinity): IConstrainedValue {
  const constrainedMax = max < min ? min : max
  return { value: typeof value === "number" ? value : value.value, min, max: constrainedMax }
}

interface ToolbarStore {
  /** 工具栏当前可用宽度；没量到之前不设上限 */
  available: number
  branchDropdownWidth: IConstrainedValue
  pushPullButtonWidth: IConstrainedValue
  setAvailable: (available: number) => void
  setBranchDropdownWidth: (width: number) => void
  resetBranchDropdownWidth: () => void
  setPushPullButtonWidth: (width: number) => void
  resetPushPullButtonWidth: () => void
}

/** 原版 updateResizableConstraints 的工具栏按钮部分（本项目没有 worktree 下拉，按两个按钮算）。 */
function constraints(
  available: number,
  branch: IConstrainedValue | number,
  pushPull: IConstrainedValue | number
): Pick<ToolbarStore, "branchDropdownWidth" | "pushPullButtonWidth"> {
  const numButtons = 2
  const branchDropdownMax = available - defaultPushPullButtonWidth
  const minimumBranchDropdownWidth =
    defaultBranchDropdownWidth > available / numButtons ? available / numButtons - 10 : defaultBranchDropdownWidth
  const branchDropdownWidth = constrain(branch, minimumBranchDropdownWidth, branchDropdownMax)

  const pushPullButtonMaxWidth = available - clamp(branchDropdownWidth)
  const minimumPushPullToolBarWidth =
    defaultPushPullButtonWidth > available / numButtons ? available / numButtons : defaultPushPullButtonWidth
  const pushPullButtonWidth = constrain(pushPull, minimumPushPullToolBarWidth, pushPullButtonMaxWidth)
  return { branchDropdownWidth, pushPullButtonWidth }
}

export const useToolbarStore = create<ToolbarStore>((set, get) => ({
  available: Infinity,
  ...constraints(
    Infinity,
    getNumber(branchDropdownWidthConfigKey, defaultBranchDropdownWidth),
    getNumber(pushPullButtonWidthConfigKey, defaultPushPullButtonWidth)
  ),
  setAvailable: available => {
    const { branchDropdownWidth, pushPullButtonWidth } = get()
    set({ available, ...constraints(available, branchDropdownWidth, pushPullButtonWidth) })
  },
  setBranchDropdownWidth: width => {
    setNumber(branchDropdownWidthConfigKey, width)
    const { available, pushPullButtonWidth } = get()
    set(constraints(available, width, pushPullButtonWidth))
  },
  resetBranchDropdownWidth: () => {
    localStorage.removeItem(branchDropdownWidthConfigKey)
    const { available, pushPullButtonWidth } = get()
    set(constraints(available, defaultBranchDropdownWidth, pushPullButtonWidth))
  },
  setPushPullButtonWidth: width => {
    setNumber(pushPullButtonWidthConfigKey, width)
    const { available, branchDropdownWidth } = get()
    set(constraints(available, branchDropdownWidth, width))
  },
  resetPushPullButtonWidth: () => {
    localStorage.removeItem(pushPullButtonWidthConfigKey)
    const { available, branchDropdownWidth } = get()
    set(constraints(available, branchDropdownWidth, defaultPushPullButtonWidth))
  }
}))
