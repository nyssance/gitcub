import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

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

export const CreatePullRequest: Story = {}
export const PushCommits: Story = {
  args: { repositoryState: { ...published, aheadBehind: { ahead: 3, behind: 0 } } }
}
export const PullCommits: Story = {
  args: { repositoryState: { ...published, aheadBehind: { ahead: 0, behind: 1 } } }
}
export const PublishBranch: Story = {
  args: { repositoryState: { ...published, aheadBehind: null } }
}
export const PublishRepository: Story = {
  args: {
    repository: { isHosted: false, platform: "github" },
    repositoryState: { ...published, remote: null, aheadBehind: null, isHosted: false }
  }
}
export const ViewStash: Story = {
  args: {
    repositoryState: {
      ...published,
      aheadBehind: { ahead: 2, behind: 0 },
      stashEntry: { name: "stash@{0}", sha: "c".repeat(40), message: "!!GitHub_Desktop<feature>", ours: true }
    }
  }
}
export const GitLabMergeRequest: Story = {
  args: { repository: { isHosted: true, platform: "gitlab" } }
}
