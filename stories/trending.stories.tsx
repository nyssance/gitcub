import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Channel } from "@tauri-apps/api/core"
import { expect, userEvent, waitFor } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import { mockTrendingBrowser, mockTrendingWebview } from "../.storybook/mocks/trending"
import i18n from "../src/lib/i18n"
import { Trending } from "../src/ui/trending/trending"

const meta = {
  title: "Discovery/Trending",
  component: Trending,
  args: { active: true },
  tags: ["desktop-window"],
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
  }),
  afterEach: assertNativeFixtures
} satisfies Meta<typeof Trending>
export default meta
type Story = StoryObj<typeof meta>

export const NativeWebpage: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: i18n.t("trending.back") })).toBeDisabled()
    await expect(canvas.getByRole("button", { name: i18n.t("trending.forward") })).toBeDisabled()
    await canvas.findByRole("button", { name: i18n.t("discover.refresh") })
  }
}
export const Connecting: Story = {
  beforeEach: withNativeFixtures({
    sync_trending_webview: () => undefined,
    control_trending_webview: mockTrendingBrowser
  }),
  play: async ({ canvas }) => {
    await canvas.findByLabelText(i18n.t("trending.stop"))
  }
}
export const Refresh: Story = {
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith(
        "sync_trending_webview",
        expect.objectContaining({ frame: expect.objectContaining({ visible: true }) })
      )
    )
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("discover.refresh") }))
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith(
        "sync_trending_webview",
        expect.objectContaining({ reload: true, onLoad: undefined })
      )
    )
    await waitFor(() => expect(canvas.queryByLabelText(i18n.t("trending.stop"))).not.toBeInTheDocument())
  }
}
export const OpenOnPlatform: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("rail.openInBrowser") }))
    await expect(nativeCall).toHaveBeenCalledWith(
      "control_trending_webview",
      expect.objectContaining({ action: "openExternal" })
    )
  }
}
export const FailedLoad: Story = {
  beforeEach: withNativeFixtures({
    sync_trending_webview: () => Promise.reject(new Error("Unable to create webview"))
  }),
  play: async ({ canvas }) => {
    await canvas.findByRole("alert")
  }
}

export const HistoryNavigation: Story = {
  beforeEach: () => {
    let atRepository = true
    let channel: Channel<string> | undefined
    return withNativeFixtures({
      sync_trending_webview: args => {
        const request = args as { onLoad?: Channel<string> }
        if (request.onLoad) channel = request.onLoad
        mockTrendingWebview(args)
      },
      control_trending_webview: args => {
        const { action } = args as { action: string }
        if (action === "back" || action === "forward") {
          atRepository = action === "forward"
          channel?.onmessage("finished")
        }
        return {
          url: atRepository ? "https://github.com/nyssance/atlas" : "https://github.com/trending",
          canGoBack: atRepository,
          canGoForward: !atRepository
        }
      }
    })()
  },
  play: async ({ canvas }) => {
    const back = canvas.getByRole("button", { name: i18n.t("trending.back") })
    const forward = canvas.getByRole("button", { name: i18n.t("trending.forward") })
    await waitFor(() => expect(back).toBeEnabled())
    await expect(forward).toBeDisabled()
    await userEvent.click(back)
    await waitFor(() => expect(forward).toBeEnabled())
    await expect(back).toBeDisabled()
    await expect(canvas.getByText("https://github.com/trending", { exact: true })).toBeVisible()
    await userEvent.click(forward)
    await waitFor(() => expect(back).toBeEnabled())
    await expect(forward).toBeDisabled()
    await expect(canvas.getByText("https://github.com/nyssance/atlas", { exact: true })).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("rail.openInBrowser") }))
    await expect(nativeCall).toHaveBeenCalledWith(
      "control_trending_webview",
      expect.objectContaining({ action: "openExternal" })
    )
  }
}
