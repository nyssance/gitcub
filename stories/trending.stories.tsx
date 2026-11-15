import type { Meta, StoryObj } from "@storybook/react-vite"

import { withNativeFixtures } from "../.storybook/mocks/native"
import { mockTrendingBrowser, mockTrendingWebview } from "../.storybook/mocks/trending"
import { Trending } from "../src/ui/trending/trending"

const meta = {
  title: "Discovery/Trending",
  component: Trending,
  args: { active: true },
  decorators: [
    Story => (
      <div className="h-[600px]">
        <Story />
      </div>
    )
  ],
  beforeEach: withNativeFixtures({
    sync_trending_webview: mockTrendingWebview,
    control_trending_webview: mockTrendingBrowser,
    "plugin:opener|open_url": () => undefined
  })
} satisfies Meta<typeof Trending>
export default meta
type Story = StoryObj<typeof meta>

export const NativeWebpage: Story = {}
export const Connecting: Story = {
  beforeEach: withNativeFixtures({
    sync_trending_webview: () => undefined,
    control_trending_webview: mockTrendingBrowser
  })
}
export const FailedLoad: Story = {
  beforeEach: withNativeFixtures({
    sync_trending_webview: () => Promise.reject(new Error("Unable to create webview"))
  })
}
