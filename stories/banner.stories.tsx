import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent } from "storybook/test"

import { Banner } from "../src/ui/changes/banner"

const meta = {
  title: "Changes/Operation banner",
  component: Banner,
  args: { message: "Committed 3 files", sticky: true, onDismiss: fn(), onAction: fn() }
} satisfies Meta<typeof Banner>
export default meta
type Story = StoryObj<typeof meta>
export const Success: Story = {}
export const Undo: Story = {
  args: { actionLabel: "Undo" },
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Undo" }))
    await expect(args.onAction).toHaveBeenCalledTimes(1)
    await expect(args.onDismiss).not.toHaveBeenCalled()
  }
}
export const Warning: Story = {
  args: { warning: true, message: "Git LFS is required for this repository", actionLabel: "Install Git LFS" }
}
export const LongMessage: Story = {
  args: {
    message: "已提交更改：修复自建 GitLab 实例中包含多层子组的远程仓库路径，并保留所有本地更改。",
    actionLabel: "撤销"
  }
}
export const Dismiss: Story = {
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: "dismiss" }))
    await expect(args.onDismiss).toHaveBeenCalledTimes(1)
  }
}
