import type { Meta, StoryObj } from "@storybook/react-vite"

import { withNativeFixtures } from "../.storybook/mocks/native"
import { Tags } from "../src/ui/history/tags"
import { repo, unavailable } from "./fixtures"
const handlers = {
  tags: () => ["v1.0", "v2.0-beta"],
  remotes: () => [["origin", "https://github.com/gitcub/gitcub.git"]],
  push: () => undefined
}
const meta = {
  title: "History/Tags",
  component: Tags,
  beforeEach: withNativeFixtures(handlers),
  args: { repo }
} satisfies Meta<typeof Tags>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const NoTags: Story = {
  beforeEach: withNativeFixtures({ ...handlers, tags: () => [] })
}
export const FailedLoad: Story = {
  beforeEach: withNativeFixtures({ ...handlers, tags: unavailable })
}

export const Loading: Story = {
  beforeEach: withNativeFixtures({ ...handlers, tags: () => new Promise<never>(() => {}) })
}
export const NoMatches: Story = {}
