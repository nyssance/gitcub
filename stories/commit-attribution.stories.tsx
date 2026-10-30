import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import { CommitAttribution } from "../src/ui/changes/commit-attribution"

const authors = ["Alex", "小熊", "Sam"].map(name => ({
  name,
  email: `${name}@example.test`,
  avatarURL: undefined,
  endpoint: null
}))
const meta = {
  title: "History/Commit authors",
  component: CommitAttribution,
  args: { avatarUsers: authors.slice(0, 1) }
} satisfies Meta<typeof CommitAttribution>
export default meta
type Story = StoryObj<typeof meta>
export const Single: Story = {}
export const CoAuthored: Story = { args: { avatarUsers: authors.slice(0, 2) } }
export const Multiple: Story = {
  args: { avatarUsers: authors },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("3 people")).toBeVisible()
  }
}
