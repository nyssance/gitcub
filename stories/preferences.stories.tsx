import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { assertNativeFixtures, installNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
import { Preferences } from "../src/ui/preferences/preferences"

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
    repo: null,
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
    for (const id of ["git", "repository", "appearance", "advanced", "trackpad", "accounts"]) {
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
export const GitIdentity: Story = { args: { initialTab: 1 } }
export const RepositoryNotSelected: Story = { args: { initialTab: 2 } }
export const Appearance: Story = { args: { initialTab: 3 } }
export const Trackpad: Story = {
  args: { initialTab: 5 },
  beforeEach: withNativeFixtures({ has_trackpad: () => true }),
  play: async ({ args }) => {
    const toggle = await within(document.body).findByRole("switch", { name: i18n.t("prefs.canvasTrackpad") })
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled", "true"))
    await expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await expect(args.onPatch).toHaveBeenCalledWith({ canvasTrackpadGestures: true })
  }
}
export const Advanced: Story = { args: { initialTab: 4 } }

const repositoryFixtures = {
  remotes: () => [["origin", "https://github.com/gitcub/gitcub.git"]],
  read_gitignore: () => "node_modules\n",
  git_identity: () => ({ name: "GitCub Preview", email: "preview@example.test" })
}
export const RepositoryLoadingCannotWrite: Story = {
  args: { initialTab: 2, repo: "/preview/repository" },
  beforeEach: withNativeFixtures({
    ...repositoryFixtures,
    read_gitignore: () => new Promise<never>(() => {}),
    git_identity: () => new Promise<never>(() => {})
  }),
  play: async () => {
    const screen = within(document.body)
    await expect(await screen.findByRole("textbox", { name: i18n.t("prefs.gitignore") })).toBeDisabled()
    await expect(screen.getByRole("textbox", { name: i18n.t("prefs.name") })).toBeDisabled()
    await expect(screen.getByRole("textbox", { name: i18n.t("prefs.email") })).toBeDisabled()
    await userEvent.keyboard("{Tab}{Tab}")
    await expect(
      nativeCall.mock.calls.some(([command]) => command === "write_gitignore" || command === "set_git_identity")
    ).toBe(false)
  }
}
export const RepositoryFailedReadCannotWrite: Story = {
  args: { initialTab: 2, repo: "/preview/repository" },
  beforeEach: withNativeFixtures({
    ...repositoryFixtures,
    read_gitignore: () => {
      throw new Error("Cannot read ignore file")
    }
  }),
  play: async () => {
    const screen = within(document.body)
    await expect(await screen.findByText(/Cannot read ignore file/)).toBeVisible()
    await expect(screen.getByRole("textbox", { name: i18n.t("prefs.gitignore") })).toBeDisabled()
    await expect(nativeCall.mock.calls.some(([command]) => command === "write_gitignore")).toBe(false)
  }
}
export const RemoteRefreshPreservesIgnoreEdits: Story = {
  args: { initialTab: 2, repo: "/preview/repository" },
  beforeEach: () => {
    let removed = false
    return withNativeFixtures({
      ...repositoryFixtures,
      remotes: () => (removed ? [] : repositoryFixtures.remotes()),
      remove_remote: () => {
        removed = true
      },
      write_gitignore: () => new Promise<never>(() => {})
    })()
  },
  play: async () => {
    const screen = within(document.body)
    const ignore = await screen.findByRole("textbox", { name: i18n.t("prefs.gitignore") })
    await waitFor(() => expect(ignore).toBeEnabled())
    await userEvent.type(ignore, "custom-output\n")
    await userEvent.click(screen.getByRole("button", { name: i18n.t("prefs.removeRemote") }))
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "origin" })).not.toBeInTheDocument())
    await expect(ignore).toHaveValue("node_modules\ncustom-output\n")
    await expect(nativeCall).toHaveBeenCalledWith("write_gitignore", {
      repo: "/preview/repository",
      content: "node_modules\ncustom-output\n"
    })
    await expect(nativeCall.mock.calls.filter(([command]) => command === "read_gitignore")).toHaveLength(1)
  }
}

export const ImportLocalDesktop: Story = {
  args: { initialTab: 4, state: { ...meta.args.state, repositories: ["/existing"], selectedRepository: "/existing" } },
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
  args: { initialTab: 4 },
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
  args: { initialTab: 4 },
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
  args: { initialTab: 5, state: { ...meta.args.state, canvasTrackpadGestures: true } },
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
  args: { initialTab: 5, state: { ...meta.args.state, canvasTrackpadGestures: true } },
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
