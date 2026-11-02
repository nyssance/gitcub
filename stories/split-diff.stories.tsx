import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { SplitDiff } from "../src/ui/diff/split-diff"
import { DiffParser } from "../src/upstream/lib/diff-parser"
import { DiffSelection, DiffSelectionType } from "../src/upstream/models/diff"
const diff = new DiffParser().parse(
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n-oldValue\n+newValue\n+extraValue\n sameValue\n"
)
const onChange = fn<(selection: DiffSelection) => void>()
const meta = {
  title: "Diff/Split text",
  component: SplitDiff,
  args: { diff, selection: null, wrap: false, query: "", searchStep: 0 },
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
export const ReadOnly: Story = {}
export const Selectable: Story = {
  args: { selection: DiffSelection.fromInitialSelection(DiffSelectionType.All), onChange }
}
export const Search: Story = { args: { query: "extraValue" } }
export const Wrapped: Story = { args: { wrap: true } }
