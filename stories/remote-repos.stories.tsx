import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor } from "storybook/test"

import { assertNativeFixtures, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
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
  },
  afterEach: assertNativeFixtures
} satisfies Meta<typeof Discover>
export default meta
type Story = StoryObj<typeof meta>

export const RateLimitedAndRetry: Story = {
  beforeEach: withNativeFixtures({
    my_repos: args => {
      if (!(args as { refresh: boolean }).refresh) throw new Error("HTTP 403 Forbidden: API rate limit exceeded")
      return [project]
    }
  }),
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole("alert")).toHaveTextContent(i18n.t("errors.rateLimited")))
    await expect(canvas.queryByText(i18n.t("discover.mineEmpty"))).not.toBeInTheDocument()
    await expect(canvas.queryByText(i18n.t("discover.signInHint"))).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("discover.refresh") }))
    await waitFor(() => expect(canvas.getByText("atlas")).toBeVisible())
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  }
}
export const SignedInEmpty: Story = {
  beforeEach: withNativeFixtures({ my_repos: () => [] }),
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByText(i18n.t("discover.mineEmpty"))).toBeVisible())
    await expect(canvas.queryByText(i18n.t("discover.signInHint"))).not.toBeInTheDocument()
  }
}
export const SignedOut: Story = {
  beforeEach: withNativeFixtures({
    my_repos: () => {
      throw new Error("github.com 还没登录")
    }
  }),
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByText(i18n.t("discover.signInHint"))).toBeVisible())
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  }
}
