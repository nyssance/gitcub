import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
import { Inbox } from "../src/ui/inbox/inbox"
import { file, pending, repo, summary, unavailable } from "./fixtures"

const meta = {
  title: "Collaboration/Inbox",
  component: Inbox,
  beforeEach: withNativeFixtures({ repo_summary: () => summary }),
  args: { repositories: [repo], hosts: [], onOpenRepo: fn() },
  decorators: [
    Story => (
      <div className="flex h-96 flex-col">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof Inbox>
export default meta
type Story = StoryObj<typeof meta>
export const Clear: Story = {}
export const LocalActions: Story = {
  beforeEach: withNativeFixtures({
    repo_summary: () => ({ ...summary, ahead: 2, conflicts: [file.path] })
  })
}
export const RemoteReview: Story = {
  args: { repositories: [], hosts: ["gitlab.example"] },
  beforeEach: withNativeFixtures({
    involved_prs: args =>
      (args as { kind: string }).kind === "reviewRequested"
        ? [
            {
              number: 42,
              head: "feature",
              title: "Review nested groups",
              url: "https://gitlab.example/group/sub/project/-/merge_requests/42"
            }
          ]
        : [],
    "plugin:opener|open_url": () => undefined
  })
}
export const Loading: Story = { beforeEach: withNativeFixtures({ repo_summary: pending }) }
export const Failure: Story = { beforeEach: withNativeFixtures({ repo_summary: unavailable }) }
