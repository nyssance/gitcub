import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
import { usePullRequestsStore } from "../src/features/pull-requests/store"
import type { CheckRun, PullRequest } from "../src/models/app-state"
import { PullRequests } from "../src/ui/pull-requests/list"
import { pending } from "./fixtures"

const remote = { host: "gitlab.example", owner: "group/sub", name: "project" }
const request: PullRequest = {
  number: 42,
  createdAt: "2026-01-01T12:00:00Z",
  title: "Fix nested groups",
  author: "bear",
  head: "feature",
  base: "main",
  headSha: "a".repeat(40),
  draft: false,
  url: "https://gitlab.example/group/sub/project/-/merge_requests/42",
  checks: "failure"
}
const run: CheckRun = {
  name: "Typecheck",
  status: "completed",
  conclusion: "failure",
  url: "https://gitlab.example/group/sub/project/-/jobs/12",
  retry: { kind: "gitlabJob", id: 12 },
  id: 12,
  rerunnable: true,
  jobId: 12
}
const handlers = {
  pull_request_repository: () => remote,
  pull_requests: () => [
    request,
    { ...request, number: 43, title: "Documentation", url: `${request.url}3`, draft: true }
  ],
  "plugin:opener|open_url": () => undefined,
  desktop_dialog_did_open: () => undefined,
  check_runs: () => [run],
  check_rerun_eligibility: () => [12],
  rerun_check: () => undefined
}
const meta = {
  title: "Collaboration/PR and MR list",
  component: PullRequests,
  // 列表数据在 store 里，跨故事会留着；每个故事从未加载开始
  beforeEach: [
    () =>
      usePullRequestsStore.setState({ repo: null, remote: null, target: null, list: [], loading: false, error: null }),
    withNativeFixtures(handlers)
  ],
  args: { remote, isOnDefaultBranch: false, onCheckout: fn(), onCreate: fn(), onCreateBranch: fn() },
  decorators: [
    Story => (
      // 分支下拉里的样子：365px 宽的 branches-container
      <div className="branches-container h-96" style={{ width: 365 }}>
        <div className="branches-container-panel">
          <Story />
        </div>
      </div>
    )
  ]
} satisfies Meta<typeof PullRequests>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Empty: Story = {
  beforeEach: withNativeFixtures({ ...handlers, pull_requests: () => [] })
}
export const NoRemote: Story = { args: { remote: null } }
export const Loading: Story = { beforeEach: withNativeFixtures({ ...handlers, pull_requests: pending }) }

export const NoSearchResults: Story = {}

export const LargeList: Story = {
  beforeEach: withNativeFixtures({
    ...handlers,
    pull_requests: () =>
      Array.from({ length: 2000 }, (_, index) => ({
        ...request,
        number: index + 1,
        title: `Request ${index + 1}`,
        url: `${request.url}/${index}`
      }))
  })
}
