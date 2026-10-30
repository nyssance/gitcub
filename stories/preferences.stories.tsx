import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { assertNativeFixtures, installNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import { PreferencesTabs, usePreferencesStore } from "../src/features/preferences/store"
import i18n from "../src/lib/i18n"
import { Preferences } from "../src/ui/preferences/preferences"
import { UncommittedChangesStrategy } from "../src/upstream/models/uncommitted-changes-strategy"

const meta = {
  title: "Settings/Navigation",
  component: Preferences,
  parameters: { layout: "fullscreen" },
  tags: ["desktop-window"],
  beforeEach: installNativeFixtures,
  afterEach: assertNativeFixtures,
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
// Migrated from macos-workflows: navigation, alignment, inactive styling, panel links and keyboard.
export const NavigationContract: Story = {
  play: async ({ args }) => {
    const screen = within(document.body)
    const dialog = await screen.findByRole("dialog")
    await expect(dialog).toHaveTextContent("github.com")
    await expect(dialog).toHaveTextContent("gitlab.com")
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    const tabs = within(dialog).getAllByRole("tab")
    await expect(tabs).toHaveLength(6)
    await expect(tabs.filter(tab => tab.getAttribute("aria-selected") === "true")).toEqual([tabs[0]])
    for (const tab of tabs) {
      const icon = tab.querySelector("svg")!.getBoundingClientRect()
      const label = tab.querySelector("span")!.getBoundingClientRect()
      await expect(Math.abs(icon.top + icon.height / 2 - label.top - label.height / 2)).toBeLessThanOrEqual(1)
      if (!tab.hasAttribute("data-active")) {
        await expect(getComputedStyle(tab).backgroundColor).toBe("rgba(0, 0, 0, 0)")
        await expect(getComputedStyle(tab).borderTopColor).toBe("rgba(0, 0, 0, 0)")
      }
    }
    for (const id of [...PreferencesTabs.slice(1), "accounts"]) {
      const tab = within(dialog).getByRole("tab", { name: i18n.t(`prefs.${id}`) })
      await userEvent.click(tab)
      await waitFor(() => {
        expect(tab).toHaveAttribute("aria-selected", "true")
        expect(tab).toHaveAttribute("data-active")
        expect(document.getElementById(tab.getAttribute("aria-controls")!)).not.toBeNull()
        expect(tabs.filter(item => item.getAttribute("aria-selected") === "true")).toEqual([tab])
      })
    }
    await expect(within(dialog).getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical")
    await userEvent.keyboard("{ArrowDown}")
    await expect(tabs[1]).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    await expect(tabs[1]).toHaveAttribute("aria-selected", "true")
    await userEvent.keyboard("{ArrowUp}")
    await expect(tabs[0]).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    await expect(tabs[0]).toHaveAttribute("aria-selected", "true")
    await userEvent.keyboard("{Escape}")
    await expect(args.onOpenChange).toHaveBeenCalledWith(false, expect.objectContaining({ reason: "escape-key" }))
  }
}
export const Accounts: Story = {}
export const GitIdentity: Story = { args: { initialTab: "git" } }
export const Appearance: Story = { args: { initialTab: "appearance" } }
export const Trackpad: Story = {
  args: { initialTab: "trackpad" },
  beforeEach: withNativeFixtures({ has_trackpad: () => true }),
  play: async ({ args }) => {
    const toggle = await within(document.body).findByRole("switch", { name: i18n.t("prefs.canvasTrackpad") })
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled", "true"))
    await expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await expect(args.onPatch).toHaveBeenCalledWith({ canvasTrackpadGestures: true })
  }
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
  }),
  play: async ({ args }) => {
    const screen = within(document.body)
    await userEvent.click(await screen.findByRole("button", { name: i18n.t("prefs.desktopImportAction") }))
    await waitFor(() =>
      expect(args.onPatch).toHaveBeenCalledWith({
        accountHosts: [],
        desktopImportHandled: true,
        repositories: ["/existing", "/imported"],
        theme: "dark",
        sidebarWidth: 280,
        externalEditor: "com.microsoft.VSCode",
        externalTerminal: "com.apple.Terminal"
      })
    )
    await expect(screen.getByRole("status")).toHaveTextContent(
      i18n.t("prefs.desktopImported", { count: 1, skipped: 1 })
    )
  }
}

export const ImportLocalDesktopFailure: Story = {
  args: { initialTab: "advanced" },
  beforeEach: withNativeFixtures({
    read_desktop_import: () => {
      throw new Error("Desktop storage changed. Retry after quitting Desktop.")
    }
  }),
  play: async ({ args }) => {
    const screen = within(document.body)
    const button = await screen.findByRole("button", { name: i18n.t("prefs.desktopImportAction") })
    await userEvent.click(button)
    await expect(await screen.findByRole("alert")).toHaveTextContent("Desktop storage changed")
    await expect(args.onPatch).not.toHaveBeenCalled()
    await expect(button).toBeEnabled()
    await userEvent.click(button)
    await waitFor(() =>
      expect(nativeCall.mock.calls.filter(([command]) => command === "read_desktop_import")).toHaveLength(2)
    )
  }
}

export const ImportLocalDesktopBusy: Story = {
  args: { initialTab: "advanced" },
  beforeEach: withNativeFixtures({ read_desktop_import: () => new Promise<never>(() => {}) }),
  play: async () => {
    const screen = within(document.body)
    await userEvent.click(await screen.findByRole("button", { name: i18n.t("prefs.desktopImportAction") }))
    await expect(await screen.findByRole("button", { name: i18n.t("prefs.desktopImporting") })).toBeDisabled()
    await expect(nativeCall.mock.calls.filter(([command]) => command === "read_desktop_import")).toHaveLength(1)
  }
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
  },
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog")
    await expect(dialog).toHaveTextContent("desktop-user")
    await expect(dialog).toHaveTextContent("GitHub Desktop")
    await expect(within(dialog).queryByPlaceholderText(i18n.t("prefs.pasteToken"))).not.toBeInTheDocument()
  }
}

export const TrackpadUnavailable: Story = {
  args: { initialTab: "trackpad", state: { ...meta.args.state, canvasTrackpadGestures: true } },
  play: async ({ args }) => {
    const screen = within(document.body)
    await expect(await screen.findByText(i18n.t("prefs.noTrackpad"))).toBeVisible()
    const toggle = screen.getByRole("switch", { name: i18n.t("prefs.canvasTrackpad") })
    await expect(toggle).toHaveAttribute("aria-disabled", "true")
    await expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await expect(args.onPatch).not.toHaveBeenCalled()
  }
}
export const TrackpadReconnect: Story = {
  args: { initialTab: "trackpad", state: { ...meta.args.state, canvasTrackpadGestures: true } },
  beforeEach: () => {
    let present = false
    return withNativeFixtures({
      has_trackpad: () => {
        const result = present
        present = !present
        return result
      }
    })()
  },
  play: async () => {
    const screen = within(document.body)
    await screen.findByText(i18n.t("prefs.noTrackpad"))
    const toggle = screen.getByRole("switch", { name: i18n.t("prefs.canvasTrackpad") })
    await expect(toggle).toHaveAttribute("aria-disabled", "true")
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled", "true"))
    await expect(toggle).toBeChecked()
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => expect(toggle).toHaveAttribute("aria-disabled", "true"))
    await expect(toggle).not.toBeChecked()
  }
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
  },
  play: async () => {
    const screen = within(document.body)
    const forcePush = await screen.findByRole("checkbox", { name: i18n.t("prefs.forcePushing") })
    await expect(forcePush).toBeChecked()
    await userEvent.click(forcePush)
    await expect(forcePush).not.toBeChecked()
    await expect(localStorage.getItem("confirmForcePush")).toBe("0")
    await userEvent.click(screen.getByRole("radio", { name: i18n.t("prefs.alwaysBringMyChangesToMyNewBranch") }))
    await expect(localStorage.getItem("uncommittedChangesStrategyKind")).toBe("MoveToNewBranch")
  }
}

export const Accessibility: Story = { args: { initialTab: "accessibility" } }
export const Notifications: Story = { args: { initialTab: "notifications" } }
