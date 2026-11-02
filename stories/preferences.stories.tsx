import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { installNativeFixtures, withNativeFixtures } from "../.storybook/mocks/native"
import { usePreferencesStore } from "../src/features/preferences/store"
import { Preferences } from "../src/ui/preferences/preferences"
import { UncommittedChangesStrategy } from "../src/upstream/models/uncommitted-changes-strategy"

const meta = {
  title: "Settings/Navigation",
  component: Preferences,
  parameters: { layout: "fullscreen" },
  beforeEach: installNativeFixtures,
  args: {
    open: true,
    onOpenChange: fn(),
    onPatch: fn(),
    onAccountsChanged: fn(),
    hosts: ["github.com", "gitlab.com"],
    accounts: {},
    state: {
      repositories: [],
      selectedRepository: null,
      sidebarWidth: 250,
      selectedTab: "changes",
      theme: "system",
      language: "",
      repoOwnership: {},
      accountHosts: [],
      oauthClients: {}
    }
  }
} satisfies Meta<typeof Preferences>
export default meta
type Story = StoryObj<typeof meta>
export const Accounts: Story = {}
export const GitIdentity: Story = { args: { initialTab: "git" } }
export const Appearance: Story = { args: { initialTab: "appearance" } }
export const Trackpad: Story = {
  args: { initialTab: "trackpad" },
  beforeEach: withNativeFixtures({ has_trackpad: () => true })
}
export const Advanced: Story = { args: { initialTab: "advanced" } }

export const ImportLocalDesktop: Story = {
  args: {
    initialTab: "advanced",
    state: { ...meta.args.state, repositories: ["/existing"], selectedRepository: "/existing" }
  },
  beforeEach: withNativeFixtures({
    read_desktop_import: () => ({
      repositories: ["/existing", "/imported"],
      selectedRepository: "/imported",
      theme: "dark",
      sidebarWidth: 280,
      externalEditor: "com.microsoft.VSCode",
      externalTerminal: "com.apple.Terminal",
      skipped: ["/missing"]
    })
  })
}

export const ImportLocalDesktopFailure: Story = {
  args: { initialTab: "advanced" },
  beforeEach: withNativeFixtures({
    read_desktop_import: () => {
      throw new Error("Desktop storage changed. Retry after quitting Desktop.")
    }
  })
}

export const ImportLocalDesktopBusy: Story = {
  args: { initialTab: "advanced" },
  beforeEach: withNativeFixtures({ read_desktop_import: () => new Promise<never>(() => {}) })
}

export const GitLabFromDesktop: Story = {
  args: {
    hosts: ["gitlab.example"],
    accounts: {
      "gitlab.example": {
        kind: "gitlab",
        login: "desktop-user",
        owners: ["desktop-user"],
        source: "desktop",
        ignored: false
      }
    }
  }
}

export const TrackpadUnavailable: Story = {
  args: { initialTab: "trackpad", state: { ...meta.args.state, canvasTrackpadGestures: true } }
}

/** Desktop preferences/prompts.tsx：确认项、切换分支时的未提交更改、提交长度警告，改了立即写回 localStorage */
export const Prompts: Story = {
  args: { initialTab: "prompts" },
  beforeEach: () => {
    const reset = () => {
      localStorage.removeItem("confirmForcePush")
      localStorage.removeItem("uncommittedChangesStrategyKind")
      usePreferencesStore.setState({
        confirmForcePush: true,
        uncommittedChangesStrategy: UncommittedChangesStrategy.AskForConfirmation
      })
    }
    reset()
    return reset
  }
}

export const Accessibility: Story = { args: { initialTab: "accessibility" } }
export const Notifications: Story = { args: { initialTab: "notifications" } }
