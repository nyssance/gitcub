import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
import { Discover } from "../src/ui/trending/discover"

const project = {
  host: "github.com",
  owner: "nyssance",
  name: "atlas",
  description: "Workspace navigation",
  language: "TypeScript",
  stars: 1,
  private: false,
  fork: false,
  url: "https://github.com/nyssance/atlas"
}
const meta = {
  title: "Discovery/Repositories",
  component: Discover,
  decorators: [
    Story => (
      <div className="h-96">
        <Story />
      </div>
    )
  ],
  args: {
    route: { kind: "mine" },
    hosts: ["github.com"],
    cloned: new Map(),
    onNavigate: fn(),
    onOpen: fn(),
    onCloned: fn()
  }
} satisfies Meta<typeof Discover>
export default meta
type Story = StoryObj<typeof meta>

export const RateLimited: Story = {
  beforeEach: withNativeFixtures({
    my_repos: args => {
      if (!(args as { refresh: boolean }).refresh) throw new Error("HTTP 403 Forbidden: API rate limit exceeded")
      return [project]
    }
  })
}
export const SignedInEmpty: Story = {
  beforeEach: withNativeFixtures({ my_repos: () => [] })
}
export const SignedOut: Story = {
  beforeEach: withNativeFixtures({
    my_repos: () => {
      throw new Error("github.com 还没登录")
    }
  })
}
