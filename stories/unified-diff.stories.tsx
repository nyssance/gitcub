import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { fn } from "storybook/test"

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
export const Selected: Story = {}
export const Unselected: Story = { args: { selection: DiffSelection.fromInitialSelection(DiffSelectionType.None) } }
export const Partial: Story = {}
export const ReadOnly: Story = { args: { onChange: undefined, selection: null } }
export const Wrapped: Story = { args: { wrap: true } }

const largeDiff = new DiffParser().parse(
  `diff --git a/large b/large\n--- a/large\n+++ b/large\n@@ -0,0 +1,100000 @@\n${Array.from({ length: 100000 }, (_, i) => `+large line ${i}\n`).join("")}`
)
export const LargeDiffSearch: Story = {
  args: { diff: largeDiff, selection: null, onChange: undefined, query: "large line 99999" }
}
