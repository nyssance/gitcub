import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ComponentProps, useEffect, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
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
  tags: ["desktop-window"],
  beforeEach: withNativeFixtures(handlers),
  afterEach: assertNativeFixtures,
  args: { open: true, repo, branch: "feature/中文", remote: target.remote, onOpenChange: fn(), onPushed: fn() }
} satisfies Meta<typeof CreatePullRequest>
export default meta
type Story = StoryObj<typeof meta>
export const GitHubFork: Story = {
  play: async ({ args }) => {
    const screen = within(document.body)
    const button = await screen.findByRole("button", { name: i18n.t("pr.createAndOpen") })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.selectOptions(screen.getByLabelText(i18n.t("pr.basePlaceholder")), "release")
    await userEvent.click(button)
    await waitFor(() => expect(args.onPushed).toHaveBeenCalledTimes(1))
    await expect(nativeCall).toHaveBeenCalledWith("push", {
      repo,
      remote: "origin",
      refspec: "HEAD:refs/heads/feature/中文",
      setUpstream: true,
      forceWithLease: false
    })
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith(
        "plugin:opener|open_url",
        expect.objectContaining({
          url: "https://github.example:8443/upstream/project/compare/release...contributor%3Afeature%2F%E4%B8%AD%E6%96%87?expand=1"
        })
      )
    )
    await expect(args.onOpenChange).toHaveBeenCalledWith(false)
  }
}
export const GitLabSubgroup: Story = {
  beforeEach: withNativeFixtures({
    ...handlers,
    pull_request_targets: () => ({
      ...target,
      kind: "gitlab",
      remote: { host: "gitlab.example", owner: "group/sub", name: "fork" },
      targets: [{ ...target.targets[0], fullName: "group/upstream/project" }]
    })
  }),
  play: async ({ args }) => {
    const screen = within(document.body)
    const button = await screen.findByRole("button", { name: i18n.t("pr.createAndOpen") })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    await waitFor(() => expect(args.onOpenChange).toHaveBeenCalledWith(false))
    const call = nativeCall.mock.calls.find(([command]) => command === "plugin:opener|open_url")!
    const url = new URL((call[1] as { url: string }).url)
    await expect(url.pathname).toBe("/group/upstream/project/-/merge_requests/new")
    await expect(url.searchParams.get("merge_request[source_project_id]")).toBe("12")
    await expect(url.searchParams.get("merge_request[target_project_id]")).toBe("32")
    await expect(url.searchParams.get("merge_request[source_branch]")).toBe("feature/中文")
  }
}
export const Loading: Story = { beforeEach: withNativeFixtures({ ...handlers, pull_request_targets: pending }) }
export const NoRemotes: Story = { beforeEach: withNativeFixtures({ ...handlers, remotes: () => [] }) }
export const DetachedHead: Story = {
  args: { branch: null },
  play: async () => {
    await expect(within(document.body).getByRole("button", { name: i18n.t("pr.createAndOpen") })).toBeDisabled()
  }
}
export const FailedPush: Story = {
  beforeEach: withNativeFixtures({ ...handlers, push: unavailable }),
  play: async ({ args }) => {
    const screen = within(document.body)
    const button = screen.getByRole("button", { name: i18n.t("pr.createAndOpen") })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    await expect(await screen.findByRole("alert")).toHaveTextContent("Preview service unavailable")
    await expect(args.onPushed).not.toHaveBeenCalled()
    await expect(args.onOpenChange).not.toHaveBeenCalled()
    await expect(nativeCall.mock.calls.some(([command]) => command === "plugin:opener|open_url")).toBe(false)
  }
}
export const RetryTargets: Story = {
  beforeEach: () => {
    let attempts = 0
    return withNativeFixtures({
      ...handlers,
      pull_request_targets: () => (++attempts === 1 ? unavailable() : target)
    })()
  },
  play: async () => {
    const screen = within(document.body)
    await expect(await screen.findByRole("alert")).toHaveTextContent("Preview service unavailable")
    await userEvent.click(screen.getByRole("button", { name: i18n.t("inbox.refresh") }))
    await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("pr.createAndOpen") })).toBeEnabled())
    await expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  }
}

export const RetryRemoteDiscovery: Story = {
  beforeEach: () => {
    let attempts = 0
    return withNativeFixtures({ ...handlers, remotes: () => (++attempts === 1 ? unavailable() : handlers.remotes()) })()
  },
  play: async () => {
    const screen = within(document.body)
    await expect(await screen.findByRole("alert")).toHaveTextContent("Preview service unavailable")
    const retry = screen.getByRole("button", { name: i18n.t("inbox.refresh") })
    await waitFor(() => expect(retry).toBeEnabled())
    await userEvent.click(retry)
    await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("pr.createAndOpen") })).toBeEnabled())
    await expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    await expect(nativeCall.mock.calls.filter(([command]) => command === "remotes")).toHaveLength(2)
  }
}
export const LoadingRemoteDiscovery: Story = {
  beforeEach: withNativeFixtures({ ...handlers, remotes: pending }),
  play: async () => {
    const screen = within(document.body)
    await expect(screen.getByRole("button", { name: i18n.t("pr.createAndOpen") })).toBeDisabled()
    await expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  }
}

export const PendingPushCannotRepeat: Story = {
  beforeEach: withNativeFixtures({ ...handlers, push: pending }),
  play: async ({ args }) => {
    const screen = within(document.body)
    const submit = screen.getByRole("button", { name: i18n.t("pr.createAndOpen") })
    await waitFor(() => expect(submit).toBeEnabled())
    await userEvent.dblClick(submit)
    await waitFor(() => expect(nativeCall.mock.calls.filter(([command]) => command === "push")).toHaveLength(1))
    await expect(submit).toBeDisabled()
    await userEvent.keyboard("{Escape}")
    await expect(screen.getByRole("dialog")).toBeVisible()
    await expect(args.onOpenChange).not.toHaveBeenCalled()
    await expect(args.onPushed).not.toHaveBeenCalled()
    await expect(nativeCall.mock.calls.some(([command]) => command === "plugin:opener|open_url")).toBe(false)
  }
}

let changeCreationBranch: () => void
let oldPush: ReturnType<typeof Promise.withResolvers<void>>
function SwitchingCreation(args: ComponentProps<typeof CreatePullRequest>) {
  const [branch, setBranch] = useState(args.branch)
  useEffect(() => {
    changeCreationBranch = () => setBranch("next")
  }, [])
  return <CreatePullRequest {...args} branch={branch} />
}
export const IgnorePushCompletionAfterBranchSwitch: Story = {
  beforeEach: () => {
    oldPush = Promise.withResolvers<void>()
    return withNativeFixtures({ ...handlers, push: () => oldPush.promise })()
  },
  render: args => <SwitchingCreation {...args} />,
  play: async ({ args }) => {
    const screen = within(document.body)
    const submit = screen.getByRole("button", { name: i18n.t("pr.createAndOpen") })
    await waitFor(() => expect(submit).toBeEnabled())
    await userEvent.click(submit)
    await waitFor(() => expect(nativeCall.mock.calls.filter(([command]) => command === "push")).toHaveLength(1))
    // Simulate an external repository/navigation update while native Git is running.
    changeCreationBranch()
    await waitFor(() =>
      expect(nativeCall.mock.calls.filter(([command]) => command === "branch_details")).toHaveLength(2)
    )
    await waitFor(() => expect(submit).toBeEnabled())
    oldPush.resolve()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await expect(args.onPushed).not.toHaveBeenCalled()
    await expect(args.onOpenChange).not.toHaveBeenCalled()
    await expect(nativeCall.mock.calls.some(([command]) => command === "plugin:opener|open_url")).toBe(false)
    await expect(screen.getByRole("dialog")).toBeVisible()
  }
}
