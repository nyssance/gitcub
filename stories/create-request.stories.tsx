import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
import type { PullRequestTargets } from "../src/lib/pull-request-navigation"
import { CreatePullRequest } from "../src/ui/pull-requests/create"
import { pending, repo, unavailable } from "./fixtures"

const target: PullRequestTargets = {
  kind: "github",
  sourceId: 12,
  remote: { host: "github.example:8443", owner: "contributor", name: "fork" },
  targets: [{ fullName: "upstream/project", id: 32, defaultBranch: "main", branches: ["main", "release"] }]
}
const handlers = {
  remotes: () => [["origin", "https://github.example:8443/contributor/fork.git"]],
  branch_details: () => [],
  pull_request_targets: () => target,
  push: () => undefined,
  "plugin:opener|open_url": () => undefined
}
const meta = {
  title: "Collaboration/Create PR or MR",
  component: CreatePullRequest,
  beforeEach: withNativeFixtures(handlers),
  args: { open: true, repo, branch: "feature/中文", remote: target.remote, onOpenChange: fn(), onPushed: fn() }
} satisfies Meta<typeof CreatePullRequest>
export default meta
type Story = StoryObj<typeof meta>
export const GitHubFork: Story = {}
export const GitLabSubgroup: Story = {
  beforeEach: withNativeFixtures({
    ...handlers,
    pull_request_targets: () => ({
      ...target,
      kind: "gitlab",
      remote: { host: "gitlab.example", owner: "group/sub", name: "fork" },
      targets: [{ ...target.targets[0], fullName: "group/upstream/project" }]
    })
  })
}
export const Loading: Story = { beforeEach: withNativeFixtures({ ...handlers, pull_request_targets: pending }) }
export const NoRemotes: Story = { beforeEach: withNativeFixtures({ ...handlers, remotes: () => [] }) }
export const DetachedHead: Story = {
  args: { branch: null }
}
export const FailedPush: Story = {
  beforeEach: withNativeFixtures({ ...handlers, push: unavailable })
}
