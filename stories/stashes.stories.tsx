import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import i18n from "../src/lib/i18n"
import { Stashes } from "../src/ui/changes/stashes"
const manual = { sha: "a".repeat(40), name: "stash@{0}", message: "WIP: preserve local changes", ours: false }
const meta = {
  title: "Changes/Stashes",
  component: Stashes,
  tags: ["desktop-window"],
  args: {
    stashes: [manual, { sha: "b".repeat(40), name: "stash@{1}", message: "!!GitCub<feature/topic>", ours: true }],
    onPop: fn(),
    onDrop: fn()
  }
} satisfies Meta<typeof Stashes>
export default meta
type Story = StoryObj<typeof meta>
export const Restore: Story = {
  play: async ({ canvas, args }) => {
    const row = canvas.getByText(manual.message).parentElement!
    await userEvent.hover(row)
    await userEvent.click(within(row).getByRole("button", { name: i18n.t("stash.pop") }))
    await expect(args.onPop).toHaveBeenCalledWith(manual.name)
    await expect(args.onDrop).not.toHaveBeenCalled()
    await expect(canvas.getByText("feature/topic")).toBeVisible()
  }
}
export const Discard: Story = {
  play: async ({ canvas, args }) => {
    const row = canvas.getByText("feature/topic").parentElement!
    await userEvent.hover(row)
    await userEvent.click(within(row).getByRole("button", { name: i18n.t("stash.drop") }))
    await expect(args.onDrop).toHaveBeenCalledWith("stash@{1}")
    await expect(args.onPop).not.toHaveBeenCalled()
  }
}
export const Empty: Story = {
  args: { stashes: [] },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("button")).not.toBeInTheDocument()
  }
}
export const LongMessage: Story = { args: { stashes: [{ ...manual, message: "Very long stash message ".repeat(20) }] } }
