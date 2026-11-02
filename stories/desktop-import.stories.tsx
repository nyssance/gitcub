import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
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
  decorators: [
    Story => (
      <div className="flex min-h-screen flex-col">
        <Story />
      </div>
    )
  ],
  beforeEach: withNativeFixtures(fixtures),
  args: { children: <h1>Continue setup</h1>, onImported: fn() }
} satisfies Meta<typeof DesktopImportWelcome>
export default meta
type Story = StoryObj<typeof meta>
export const Detected: Story = {}
export const NotInstalled: Story = {
  beforeEach: withNativeFixtures({
    detect_desktop_import: () => ({ installed: false, hasData: false, handled: false })
  })
}
export const InstalledWithoutData: Story = {
  beforeEach: withNativeFixtures({ ...fixtures, detect_desktop_import: () => ({ ...available, hasData: false }) })
}
export const Failure: Story = {
  beforeEach: withNativeFixtures({
    ...fixtures,
    finish_desktop_import: () => {
      throw new Error("Unable to save imported settings")
    }
  })
}
export const Busy: Story = {
  beforeEach: withNativeFixtures({ ...fixtures, finish_desktop_import: () => new Promise<never>(() => {}) })
}
