import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, within } from "storybook/test"

import i18n from "../src/lib/i18n"
import { buildDefaultMenuTemplate } from "../src/lib/menu/build-default-menu"
import { snapshotMenu } from "../src/lib/menu/snapshot"
import { menuFromElectronMenu } from "../src/models/app-menu"
import { NoChanges } from "../src/ui/changes/no-changes"

// The native menu template is the same one the app renders; the empty-state actions read labels,
// shortcuts and enabled flags from it like Desktop's AppMenu.
const appMenu = menuFromElectronMenu(
  snapshotMenu(
    buildDefaultMenuTemplate({
      selectedExternalEditor: "Zed",
      selectedShell: null,
      askForConfirmationOnForcePush: true,
      askForConfirmationOnRepositoryRemoval: true
    })
  )
)
const published = {
  branch: "feature",
  remote: "origin",
  aheadBehind: { ahead: 0, behind: 0 },
  tagsToPush: null,
  isForcePush: false,
  defaultBranch: "main",
  hasCurrentPullRequest: false,
  isHosted: true,
  stashEntry: null
}
const meta = {
  title: "Changes/No changes",
  component: NoChanges,
  parameters: { layout: "fullscreen" },
  args: {
    repository: { isHosted: true, platform: "github" },
    appMenu,
    repositoryState: published,
    isExternalEditorAvailable: true,
    onOpenIntegrationPreferences: fn()
  },
  decorators: [
    Story => (
      <div className="bg-background text-foreground h-[600px] overflow-hidden">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof NoChanges>
export default meta
type Story = StoryObj<typeof meta>

export const CreatePullRequest: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(i18n.t("changes.noChanges"))
    const headings = canvas.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)
    await expect(headings).toEqual([
      i18n.t("noChanges.createPullRequest"),
      i18n.t("noChanges.openInEditor"),
      i18n.t("noChanges.showInFileManager", { fileManager: i18n.t("noChanges.fileManager.finder") }),
      i18n.t("noChanges.viewOnGitHub", { platform: "GitHub" })
    ])
    const primary = canvas.getAllByRole("heading", { level: 2 })[0].closest(".suggested-action")!
    await expect(primary).toHaveClass("primary")
    await expect(within(primary as HTMLElement).getByRole("button")).toHaveTextContent("Pull Request")
  }
}
export const PushCommits: Story = {
  args: { repositoryState: { ...published, aheadBehind: { ahead: 3, behind: 0 } } },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent(
      i18n.t("noChanges.push", { items: i18n.t("noChanges.pushTypeCommits"), remote: "origin" })
    )
    await expect(
      canvas.getByRole("button", { name: i18n.t("noChanges.pushButton", { remote: "origin" }) })
    ).toBeVisible()
  }
}
export const PullCommits: Story = {
  args: { repositoryState: { ...published, aheadBehind: { ahead: 0, behind: 1 } } },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent(
      i18n.t("noChanges.pull", { count: 1, commits: "1", remote: "origin" })
    )
  }
}
export const PublishBranch: Story = {
  args: { repositoryState: { ...published, aheadBehind: null } },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent(i18n.t("noChanges.publishBranch"))
    await expect(canvas.getByText("feature")).toBeVisible()
  }
}
export const PublishRepository: Story = {
  args: {
    repository: { isHosted: false, platform: "github" },
    repositoryState: { ...published, remote: null, aheadBehind: null, isHosted: false }
  },
  play: async ({ canvas }) => {
    const headings = canvas.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)
    await expect(headings[0]).toBe(i18n.t("noChanges.publishRepository", { platform: "GitHub" }))
    await expect(headings).not.toContain(i18n.t("noChanges.viewOnGitHub", { platform: "GitHub" }))
  }
}
export const ViewStash: Story = {
  args: {
    repositoryState: {
      ...published,
      aheadBehind: { ahead: 2, behind: 0 },
      stashEntry: { name: "stash@{0}", sha: "c".repeat(40), message: "!!GitHub_Desktop<feature>", ours: true }
    }
  },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent(i18n.t("noChanges.viewStash"))
  }
}
export const GitLabMergeRequest: Story = {
  args: { repository: { isHosted: true, platform: "gitlab" } },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent(
      i18n.t("noChanges.createMergeRequest")
    )
  }
}
