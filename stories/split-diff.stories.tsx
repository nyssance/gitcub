import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor } from "storybook/test"

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
  tags: ["desktop-window"],
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
export const ReadOnly: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/oldValue/)).toBeVisible()
    await expect(canvas.getByText(/newValue/)).toBeVisible()
    await expect(canvas.getByText(/extraValue/)).toBeVisible()
  }
}
export const Selectable: Story = {
  args: { selection: DiffSelection.fromInitialSelection(DiffSelectionType.All), onChange },
  play: async ({ canvas }) => {
    const checkbox = await canvas.findByRole("checkbox", { name: "Line 1 added" })
    checkbox.focus()
    await userEvent.keyboard(" ")
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const selection = onChange.mock.calls.at(-1)![0]
    await expect(selection.isSelected(1)).toBe(true)
    await expect(selection.isSelected(2)).toBe(false)
    await expect(selection.isSelected(3)).toBe(true)
  }
}
export const Search: Story = { args: { query: "extraValue" } }
export const Wrapped: Story = { args: { wrap: true } }
