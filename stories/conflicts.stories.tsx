import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { Conflicts } from "../src/ui/changes/conflicts"
import { file } from "./fixtures"
const conflicted = { ...file, change: "conflicted" as const }
const meta = {
  title: "Changes/Conflict resolution",
  component: Conflicts,
  args: {
    operation: "merge",
    files: [conflicted],
    ours: "main",
    theirs: "feature/topic",
    onResolve: fn(),
    onAbort: fn(),
    onContinue: fn()
  }
} satisfies Meta<typeof Conflicts>
export default meta
type Story = StoryObj<typeof meta>
export const UnresolvedMerge: Story = {}
export const ResolvedMerge: Story = {
  args: { files: [] }
}
export const ResolvedRebase: Story = {
  ...ResolvedMerge,
  args: { operation: "rebase", files: [] }
}
export const Inactive: Story = {
  args: { operation: null }
}

export const RebaseSides: Story = {
  args: { operation: "rebase" }
}
const deleted = {
  ...conflicted,
  conflict: { hasBase: true, hasOurs: true, hasTheirs: false, markers: 0, binary: false }
}
export const ModifyDelete: Story = {
  args: { files: [deleted] }
}
export const ResolvedCherryPick: Story = {
  args: { operation: "cherry-pick", files: [] }
}
export const ResolvedRevert: Story = {
  args: { operation: "revert", files: [] }
}
