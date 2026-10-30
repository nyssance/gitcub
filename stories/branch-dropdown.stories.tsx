import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { assertNativeFixtures, withNativeFixtures } from "../.storybook/mocks/native"
import { usePullRequestsStore } from "../src/features/pull-requests/store"
import i18n from "../src/lib/i18n"
import { PullRequestBadge } from "../src/ui/branches/pull-request-badge"
import { PullRequests } from "../src/ui/pull-requests/list"
import { BranchDropdown } from "../src/ui/toolbar/branch-dropdown"
import { repo } from "./fixtures"

const sha = (n: number) => String(n).repeat(40).slice(0, 40)
const local = (name: string, n: number, upstream: string | null = null) => ({
  name,
  upstream,
  sha: sha(n),
  remote: false,
  reference: `refs/heads/${name}`
})
const remote = (name: string, n: number) => ({
  name,
  upstream: null,
  sha: sha(n),
  remote: true,
  reference: `refs/remotes/${name}`
})
const branches = [
  local("main", 1, "origin/main"),
  local("codex/vendor-parity", 2),
  remote("origin/main", 1),
  remote("origin/dependabot/cargo/base64-0.23.1", 3),
  remote("origin/dependabot/cargo/clap-4.6.6", 4),
  remote("origin/dependabot/npm_and_yarn/playwright-1.60.0", 5)
]
const day = 24 * 60 * 60
const now = Math.floor(Date.now() / 1000)
const ages: Record<string, number> = {
  [sha(1)]: day - 3600,
  [sha(2)]: 30 * day,
  [sha(3)]: 90 * day,
  [sha(4)]: 90 * day,
  [sha(5)]: 40 * day
}
const handlers = {
  store_entries: () => ({}),
  store_set: () => null,
  branch_details: () => branches,
  recent_branches: () => ["main", "codex/vendor-parity"],
  remotes: () => [["origin", "https://github.com/nyssance/gitcub.git"]],
  get_remote_head: () => "main",
  get_config_value: () => null,
  worktrees: () => [],
  branch_policy: () => null,
  repo_status: () => ({
    branch: "main",
    changes: [],
    remote: "origin",
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    operation: null,
    theirs: null
  }),
  git_execute: (args: unknown) => {
    const shas = ((args as { stdin?: string | null }).stdin ?? "").split("\n").filter(Boolean)
    return {
      exitCode: 0,
      stdout: shas.map(s => `Preview <preview@example.test> ${now - (ages[s] ?? day)} +0000`).join("\0"),
      stderr: "",
      path: repo,
      gitError: null,
      gitErrorDescription: null
    }
  }
}

const meta = {
  title: "Toolbar/Branch dropdown",
  component: BranchDropdown,
  tags: ["desktop-window"],
  beforeEach: withNativeFixtures(handlers),
  afterEach: assertNativeFixtures,
  args: {
    repo,
    branch: "main",
    onCheckout: fn(async () => {}),
    onCreate: fn(async () => {}),
    onDelete: fn(async () => {}),
    onMerge: fn(async () => {}),
    onRebase: fn(async () => {}),
    onRename: fn(),
    onWorktrees: fn(),
    onOpenWorktree: fn()
  },
  decorators: [
    Story => (
      <div className="flex h-12 w-[900px]">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof BranchDropdown>
export default meta
type Story = StoryObj<typeof meta>

const open = async (canvas: ReturnType<typeof within>) => {
  await userEvent.click(canvas.getByRole("button", { name: /main/ }))
  const page = within(document.body)
  await page.findByText(i18n.t("desktopUI.defaultBranch"))
  return page
}

/** Desktop BranchesContainer：Default / Recent / Other 三组，过滤框右侧 New Branch，底部「选分支合并」 */
export const Open: Story = {
  play: async ({ canvas }) => {
    const page = await open(canvas)
    await expect(page.getByText(i18n.t("desktopUI.recentBranches"))).toBeVisible()
    await expect(page.getByText(i18n.t("desktopUI.otherBranches"))).toBeVisible()
    await expect(page.getByRole("button", { name: i18n.t("desktopUI.newBranch") })).toBeVisible()
    await page.findByText("23 hours ago")
  }
}

export const CheckoutFromList: Story = {
  play: async ({ canvas, args }) => {
    const page = await open(canvas)
    await userEvent.click(page.getByText("codex/vendor-parity"))
    await expect(args.onCheckout).toHaveBeenCalledWith("codex/vendor-parity")
  }
}

/** 底部按钮进入「选分支合并」：点列表里的分支合并到当前分支 */
export const MergeIntoCurrent: Story = {
  play: async ({ canvas, args }) => {
    const page = await open(canvas)
    await userEvent.click(page.getByRole("button", { name: new RegExp(i18n.t("desktopUI.chooseBranchToMergeInto")) }))
    await userEvent.click(page.getByText("codex/vendor-parity"))
    await expect(args.onMerge).toHaveBeenCalledWith("refs/heads/codex/vendor-parity", false)
    await expect(args.onCheckout).not.toHaveBeenCalled()
  }
}

const prRemote = { host: "github.com", owner: "nyssance", name: "gitcub" }
const prRequest = {
  number: 17,
  createdAt: "2026-10-01T12:00:00Z",
  title: "Align toolbar with Desktop",
  author: "bear",
  head: "main",
  base: "main",
  headSha: "a".repeat(40),
  draft: false,
  url: "https://github.com/nyssance/gitcub/pull/17",
  checks: "failure"
}

/** Desktop BranchesContainer 的「Pull Requests」页签与分支按钮上的 PR 徽章（#17 + CI 状态） */
export const PullRequestsTab: Story = {
  args: {
    // 下拉宽度用原版默认 230px：徽章挤在文字右侧、箭头左侧
    pullRequestCount: 1,
    badge: <PullRequestBadge request={prRequest} remote={prRemote} />,
    renderPullRequests: ({ close, isOnDefaultBranch, onCreateBranch }) => (
      <PullRequests
        remote={prRemote}
        isOnDefaultBranch={isOnDefaultBranch}
        onCheckout={close}
        onCreate={close}
        onCreateBranch={onCreateBranch}
      />
    )
  },
  beforeEach: [
    () => usePullRequestsStore.setState({ remote: null, target: null, list: [], loading: false, error: null }),
    withNativeFixtures({ ...handlers, pull_request_repository: () => prRemote, pull_requests: () => [prRequest] })
  ],
  decorators: [
    Story => (
      <div className="flex h-12" style={{ width: 230 }}>
        <Story />
      </div>
    )
  ],
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: `#17 ${i18n.t("pr.checksDetail")}` })).toBeEnabled()
    await userEvent.click(canvas.getByRole("button", { name: /main/ }))
    const page = within(document.body)
    await userEvent.click(await page.findByRole("tab", { name: new RegExp(i18n.t("tabs.pr")) }))
    await expect(await page.findByText(prRequest.title)).toBeVisible()
  }
}
