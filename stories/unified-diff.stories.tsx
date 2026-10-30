import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, fireEvent, fn, userEvent, waitFor } from "storybook/test"

import { SplitDiff } from "../src/ui/diff/split-diff"
import { DiffParser } from "../src/upstream/lib/diff-parser"
import { DiffSelection, DiffSelectionType } from "../src/upstream/models/diff"

// Desktop bebc062caafcf818993b9f53397b976d33484231: side-by-side-diff-row.tsx,
// unified mode. Reproduces the reported old/new line 272 selection gutter.
const diff = new DiffParser().parse(
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -269,5 +269,5 @@\n context269\n context270\n context271\n-oldValue\n+newValue\n context273\n"
)
const meta = {
  title: "Diff/Unified text",
  component: SplitDiff,
  tags: ["desktop-window"],
  parameters: {
    a11y: {
      // Desktop 3.6.7 原版选中行号：白字压 blue-400 #2188ff 只有 3.48:1（WCAG AA 要 4.5:1）。
      // .storybook/desktop-layout.spec.ts 以原版主题值为基准核对这组选中态颜色，
      // 所以这里登记为已知上游偏差而不改色；其余元素仍按 error 级别检查。
      config: { rules: [{ id: "color-contrast", selector: ".line-number.line-selected label", enabled: false }] }
    }
  },
  args: {
    diff,
    split: false,
    selection: DiffSelection.fromInitialSelection(DiffSelectionType.All),
    onChange: fn(),
    wrap: false,
    query: "",
    searchStep: 0
  },
  render: args => {
    const [selection, setSelection] = useState(args.selection)
    return (
      <SplitDiff
        {...args}
        selection={selection}
        onChange={
          args.onChange
            ? next => {
                setSelection(next)
                args.onChange?.(next)
              }
            : undefined
        }
      />
    )
  },
  decorators: [
    Story => (
      <div className="flex h-96 flex-col">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof SplitDiff>
export default meta
type Story = StoryObj<typeof meta>
export const Selected: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole("checkbox", { name: "Line 272 added" })).toBeChecked()
    await expect(canvas.getByRole("checkbox", { name: "Line 272 deleted" })).toBeChecked()
    await expect(canvasElement.querySelectorAll(".line-number-check svg")).toHaveLength(2)
    await expect(canvasElement.querySelectorAll(".hunk-handle svg")).toHaveLength(1)
    const gutter = canvasElement.querySelector(".line-number.line-selected")!
    await expect(gutter.getBoundingClientRect().width).toBe(91)
    // Desktop keeps the selected column divider distinct from its fill.
    const selectedStyle = getComputedStyle(gutter)
    await expect(selectedStyle.borderRightColor).not.toBe(selectedStyle.backgroundColor)
    await expect(getComputedStyle(gutter.querySelector("label > span")!).borderRightColor).toBe(
      selectedStyle.borderRightColor
    )
  }
}
export const Unselected: Story = { args: { selection: DiffSelection.fromInitialSelection(DiffSelectionType.None) } }
export const Partial: Story = {
  play: async ({ canvas, canvasElement }) => {
    const line = await canvas.findByRole("checkbox", { name: "Line 272 added" })
    line.focus()
    await userEvent.keyboard(" ")
    await expect(line).not.toBeChecked()
    await expect(canvas.getByRole("checkbox", { name: "Line 272 deleted" })).toBeChecked()
    await expect(canvasElement.querySelector('input[aria-checked="mixed"]')).not.toBeNull()
  }
}
export const ToggleHunk: Story = {
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByRole("checkbox", { name: "Line 272 added" })
    const handle = canvasElement.querySelector<HTMLLabelElement>("label.hunk-handle")!
    await userEvent.click(handle)
    await expect(canvas.getByRole("checkbox", { name: "Line 272 added" })).not.toBeChecked()
    await expect(canvas.getByRole("checkbox", { name: "Line 272 deleted" })).not.toBeChecked()
    await userEvent.click(handle)
    await expect(canvas.getByRole("checkbox", { name: "Line 272 added" })).toBeChecked()
  }
}
export const HoverHunk: Story = {
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByRole("checkbox", { name: "Line 272 added" })
    await userEvent.hover(canvasElement.querySelector("label.hunk-handle")!)
    await waitFor(() => expect(canvasElement.querySelectorAll(".line-number.hover")).toHaveLength(2))
  }
}
export const ReadOnly: Story = { args: { onChange: undefined, selection: null } }
export const Wrapped: Story = { args: { wrap: true } }

export const DragSelection: Story = {
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByRole("checkbox", { name: "Line 272 added" })
    const start = canvasElement.querySelector(".deleted .line-number")!
    const end = canvasElement.querySelector(".added .line-number")!
    const a = start.getBoundingClientRect(),
      b = end.getBoundingClientRect()
    fireEvent.mouseDown(start, { button: 0, clientX: a.x + 30, clientY: a.y + 10 })
    fireEvent.mouseMove(document, { clientX: b.x + 30, clientY: b.y + 10 })
    fireEvent.mouseUp(document)
    await waitFor(() => expect(canvas.getByRole("checkbox", { name: "Line 272 added" })).not.toBeChecked())
    await expect(canvas.getByRole("checkbox", { name: "Line 272 deleted" })).not.toBeChecked()
  }
}
const largeDiff = new DiffParser().parse(
  `diff --git a/large b/large\n--- a/large\n+++ b/large\n@@ -0,0 +1,100000 @@\n${Array.from({ length: 100000 }, (_, i) => `+large line ${i}\n`).join("")}`
)
export const LargeDiffSearch: Story = {
  args: { diff: largeDiff, selection: null, onChange: undefined, query: "large line 99999" },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByText("large line 99999")).toBeVisible()
    await expect(canvasElement.querySelectorAll(".row").length).toBeLessThan(100)
    await expect(canvasElement.querySelector(".cm-search-result")).toHaveTextContent("large line 99999")
  }
}

export const ExpandContext: Story = {
  args: { onExpand: fn() },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button", { name: "Expand Up" })
    await userEvent.click(button)
    await expect(args.onExpand).toHaveBeenCalledWith(diff.hunks[0], "up")
  }
}

export const DragOutsideViewport: Story = {
  args: { diff: largeDiff, selection: DiffSelection.fromInitialSelection(DiffSelectionType.None) },
  play: async ({ canvas, canvasElement, args }) => {
    const line = await canvas.findByRole("checkbox", { name: "Line 1 added" })
    const gutter = line.closest(".line-number")!
    const viewport = canvasElement.querySelector<HTMLElement>(".unified-diff")!
    const rect = viewport.getBoundingClientRect()
    fireEvent.mouseDown(gutter, { button: 0, clientX: rect.x + 30, clientY: rect.y + 30 })
    fireEvent.mouseMove(document, { clientX: rect.x + 30, clientY: rect.bottom + 10 })
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(80))
    fireEvent.mouseUp(document)
    await waitFor(() => expect(args.onChange).toHaveBeenCalled())
    const next = args.onChange!.mock.calls.at(-1)![0]
    await expect(next.isSelected(1)).toBe(true)
    await expect(next.isSelected(20)).toBe(true)
  }
}
export const CancelDragWithEscape: Story = {
  play: async ({ canvas, canvasElement, args }) => {
    const line = await canvas.findByRole("checkbox", { name: "Line 272 added" })
    fireEvent.mouseDown(line.closest(".line-number")!, { button: 0 })
    fireEvent.keyDown(canvasElement.querySelector(".unified-diff")!, { key: "Escape" })
    fireEvent.mouseUp(document)
    await expect(args.onChange).not.toHaveBeenCalled()
    await expect(line).toBeChecked()
  }
}
