import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
import { DesktopImportWelcome } from "../src/ui/welcome/desktop-import"

const state = {
  repositories: ["C:/Projects/example"],
  selectedRepository: "C:/Projects/example",
  desktopImportHandled: true,
  sidebarWidth: 250,
  selectedTab: "changes",
  theme: "dark",
  language: "",
  repoOwnership: {},
  accountHosts: [],
  oauthClients: {}
}
const available = { installed: true, hasData: true, handled: false }
const fixtures = { detect_desktop_import: () => available, finish_desktop_import: () => state }
const meta = {
  title: "Onboarding/DesktopImport",
  component: DesktopImportWelcome,
  parameters: { layout: "fullscreen" },
  tags: ["desktop-window"],
  decorators: [
    Story => (
      <div className="flex min-h-screen flex-col">
        <Story />
      </div>
    )
  ],
  beforeEach: withNativeFixtures(fixtures),
  afterEach: assertNativeFixtures,
  args: { children: <h1>Continue setup</h1>, onImported: fn() }
} satisfies Meta<typeof DesktopImportWelcome>
export default meta
type Story = StoryObj<typeof meta>
export const Detected: Story = {}
export const Import: Story = {
  play: async ({ canvas, args }) => {
    await userEvent.click(await canvas.findByRole("button", { name: i18n.t("prefs.desktopImportAction") }))
    await expect(await canvas.findByRole("heading", { name: "Continue setup" })).toBeVisible()
    await expect(nativeCall).toHaveBeenCalledWith("finish_desktop_import", { import: true })
    await expect(args.onImported).toHaveBeenCalledWith(state)
  }
}
export const Skip: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("button", { name: i18n.t("welcome.desktopSkip") }))
    await expect(await canvas.findByRole("heading", { name: "Continue setup" })).toBeVisible()
    await expect(nativeCall).toHaveBeenCalledWith("finish_desktop_import", { import: false })
  }
}
export const NotInstalled: Story = {
  beforeEach: withNativeFixtures({
    detect_desktop_import: () => ({ installed: false, hasData: false, handled: false })
  }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("heading", { name: "Continue setup" })).toBeVisible()
    await expect(nativeCall).toHaveBeenCalledTimes(1)
  }
}
export const AlreadyHandled: Story = {
  beforeEach: withNativeFixtures({ detect_desktop_import: () => ({ ...available, handled: true }) }),
  play: NotInstalled.play
}
export const InstalledWithoutData: Story = {
  beforeEach: withNativeFixtures({ ...fixtures, detect_desktop_import: () => ({ ...available, hasData: false }) }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("button", { name: i18n.t("prefs.desktopImportAction") })).toBeDisabled()
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("welcome.desktopSkip") }))
    await expect(await canvas.findByRole("heading", { name: "Continue setup" })).toBeVisible()
  }
}
export const FailureAndRetry: Story = {
  beforeEach: withNativeFixtures({
    ...fixtures,
    finish_desktop_import: () => {
      throw new Error("Unable to save imported settings")
    }
  }),
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button", { name: i18n.t("prefs.desktopImportAction") })
    await userEvent.click(button)
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Unable to save")
    await expect(args.onImported).not.toHaveBeenCalled()
    await expect(canvas.queryByRole("heading", { name: "Continue setup" })).toBeNull()
    await userEvent.click(button)
    await waitFor(() =>
      expect(nativeCall.mock.calls.filter(([cmd]) => cmd === "finish_desktop_import")).toHaveLength(2)
    )
  }
}
export const Busy: Story = {
  beforeEach: withNativeFixtures({ ...fixtures, finish_desktop_import: () => new Promise<never>(() => {}) }),
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("button", { name: i18n.t("prefs.desktopImportAction") }))
    await expect(await canvas.findByRole("button", { name: i18n.t("prefs.desktopImporting") })).toBeDisabled()
    await expect(canvas.getByRole("button", { name: i18n.t("welcome.desktopSkip") })).toBeDisabled()
  }
}
