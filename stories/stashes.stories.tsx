import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { Stashes } from "../src/ui/changes/stashes"
const manual = { sha: "a".repeat(40), name: "stash@{0}", message: "WIP: preserve local changes", ours: false }
const meta = {
  title: "Changes/Stashes",
  component: Stashes,
  args: {
    stashes: [manual, { sha: "b".repeat(40), name: "stash@{1}", message: "!!GitCub<feature/topic>", ours: true }],
    onPop: fn(),
    onDrop: fn()
  }
} satisfies Meta<typeof Stashes>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Empty: Story = {
  args: { stashes: [] }
}
export const LongMessage: Story = { args: { stashes: [{ ...manual, message: "Very long stash message ".repeat(20) }] } }
