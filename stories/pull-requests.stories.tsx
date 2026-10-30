import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import { APICheckConclusion, APICheckStatus } from "../src/lib/api"
import { canDropCommits, endCommitDrag, startCommitDrag } from "../src/lib/commit-drag"
import i18n from "../src/lib/i18n"
import type { CheckRun, PullRequest } from "../src/models/app-state"
import { Button } from "../src/ui/base/button"
import { PullRequests } from "../src/ui/pull-requests/list"
import { pending, unavailable } from "./fixtures"

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
  tags: ["desktop-window"],
  beforeEach: withNativeFixtures(handlers),
  afterEach: assertNativeFixtures,
  args: { remote, onCheckout: fn(), onCreate: fn() },
  decorators: [
    Story => (
      <div className="flex h-96 flex-col">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof PullRequests>
export default meta
type Story = StoryObj<typeof meta>
export const DropCommits: Story = {
  args: { repo: "/fixture", onCherryPick: fn() },
  play: async ({ canvas, args }) => {
    const row = (await canvas.findByText(request.title)).closest('[data-slot="context-menu-trigger"]')!
    const shas = ["a".repeat(40), "b".repeat(40)]
    const external = new DataTransfer()
    external.setData("text/plain", shas[0])
    row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: external }))
    await expect(args.onCherryPick).not.toHaveBeenCalled()
    const data = new DataTransfer()
    startCommitDrag(data, "/different-repository", shas)
    row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }))
    await expect(args.onCherryPick).not.toHaveBeenCalled()
    startCommitDrag(data, "/fixture", shas)
    await expect(canDropCommits(data, "/fixture")).toBe(true)
    row.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }))
    await expect(row).toHaveAttribute("data-drop-target", "true")
    row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }))
    await expect(args.onCherryPick).toHaveBeenCalledWith(request, remote, shas)
    row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }))
    await expect(args.onCherryPick).toHaveBeenCalledTimes(1)
    startCommitDrag(data, "/fixture", shas)
    endCommitDrag()
    row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }))
    await expect(args.onCherryPick).toHaveBeenCalledTimes(1)
  }
}
export const FilterAndCheckout: Story = {
  play: async ({ canvas, args }) => {
    await canvas.findByText(request.title)
    await userEvent.type(canvas.getByRole("textbox", { name: i18n.t("pr.search") }), "nested")
    await expect(canvas.queryByText("Documentation")).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("pr.checkout") }))
    await expect(args.onCheckout).toHaveBeenCalledWith(request, remote)
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("pr.newPr") }))
    await expect(args.onCreate).toHaveBeenCalledTimes(1)
  }
}
export const ReviewOnPlatform: Story = {
  play: async ({ canvas, args }) => {
    const title = await canvas.findByRole("button", { name: request.title })
    title.focus()
    await expect(title).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("plugin:opener|open_url", expect.objectContaining({ url: request.url }))
    )
    await expect(args.onCheckout).not.toHaveBeenCalled()
  }
}
export const ConfirmRetryFailedCI: Story = {
  play: async ({ canvas }) => {
    await canvas.findByText(request.title)
    await userEvent.click(canvas.getAllByRole("button", { name: i18n.t("pr.checksDetail") })[0])
    const page = within(document.body)
    await userEvent.click(await page.findByRole("button", { name: i18n.t("ci.rerun") }))
    await userEvent.click(await page.findByRole("menuitem", { name: i18n.t("ci.rerunFailed") }))
    const dialog = within(await page.findByRole("dialog", { name: i18n.t("ci.rerunFailed") }))
    await expect(nativeCall.mock.calls.some(([command]) => command === "rerun_check")).toBe(false)
    await userEvent.click(dialog.getByRole("button", { name: i18n.t("ci.rerunChecks") }))
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith(
        "rerun_check",
        expect.objectContaining({
          host: remote.host,
          owner: remote.owner,
          name: remote.name,
          target: run.retry,
          mode: "failed",
          jobId: undefined
        })
      )
    )
  }
}
export const Empty: Story = { beforeEach: withNativeFixtures({ ...handlers, pull_requests: () => [] }) }
export const NoRemote: Story = { args: { remote: null } }
export const Loading: Story = { beforeEach: withNativeFixtures({ ...handlers, pull_requests: pending }) }
export const RetryLoadingFailure: Story = {
  beforeEach: () => {
    let attempt = 0
    return withNativeFixtures({ ...handlers, pull_requests: () => (++attempt === 1 ? unavailable() : [request]) })()
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Preview service unavailable/)).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("inbox.refresh") }))
    await expect(await canvas.findByText(request.title)).toBeVisible()
  }
}

let oldRepository: ReturnType<typeof Promise.withResolvers<typeof remote>>
const nextRemote = { ...remote, name: "next-project" }
function SwitchingRequests(args: ComponentProps<typeof PullRequests>) {
  const [selected, setSelected] = useState(args.remote)
  return (
    <>
      <Button onClick={() => setSelected(nextRemote)}>Switch repository</Button>
      <PullRequests {...args} remote={selected} />
    </>
  )
}
export const IgnoreOldRepositoryLookup: Story = {
  beforeEach: () => {
    oldRepository = Promise.withResolvers<typeof remote>()
    return withNativeFixtures({
      ...handlers,
      pull_request_repository: args =>
        (args as { name: string }).name === remote.name ? oldRepository.promise : nextRemote
    })()
  },
  render: args => <SwitchingRequests {...args} />,
  play: async ({ canvas, args }) => {
    await waitFor(() => expect(nativeCall).toHaveBeenCalledWith("pull_request_repository", remote))
    await userEvent.click(canvas.getByRole("button", { name: "Switch repository" }))
    await canvas.findByText(request.title)
    oldRepository.resolve(remote)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await expect(nativeCall).not.toHaveBeenCalledWith("pull_requests", expect.objectContaining({ name: remote.name }))
    await userEvent.click(canvas.getAllByRole("button", { name: i18n.t("pr.checkout") })[0])
    await expect(args.onCheckout).toHaveBeenCalledWith(request, nextRemote)
  }
}

const githubRemote = { host: "github.com", owner: "bear", name: "project" }
const githubRequest = { ...request, url: "https://github.com/bear/project/pull/42" }
const githubRun: CheckRun = {
  ...run,
  checkSuiteId: 100,
  retry: { kind: "githubWorkflow", id: 200 },
  url: "https://github.com/bear/project/actions/runs/200/job/12",
  workflow: {
    id: 200,
    workflow_id: 1,
    check_suite_id: 100,
    name: "Build workflow",
    event: "pull_request",
    created_at: "2026-10-21T00:00:00Z",
    cancel_url: "",
    rerun_url: "",
    logs_url: ""
  },
  steps: [
    {
      name: "Compile",
      number: 1,
      status: APICheckStatus.Completed,
      conclusion: APICheckConclusion.Failure,
      started_at: "2026-10-21T00:00:00Z",
      completed_at: "2026-10-21T00:00:10Z",
      log: ""
    }
  ]
}
const githubHandlers = {
  ...handlers,
  pull_request_repository: () => githubRemote,
  pull_requests: () => [githubRequest],
  check_runs: () => [githubRun]
}
export const GitHubFailureAutomaticallyExpands: Story = {
  args: { remote: githubRemote },
  beforeEach: withNativeFixtures(githubHandlers),
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("button", { name: i18n.t("pr.checksDetail") }))
    const page = within(document.body)
    await expect(await page.findByText("Build workflow")).toBeVisible()
    await expect(await page.findByText("Compile")).toBeVisible()
    await userEvent.click(page.getByRole("link", { name: i18n.t("desktopUI.viewStep", { name: "Compile" }) }))
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith(
        "plugin:opener|open_url",
        expect.objectContaining({ url: `${githubRun.url}/#step:1:1` })
      )
    )
    await userEvent.click(page.getByRole("button", { name: i18n.t("ci.rerunJob", { name: githubRun.name }) }))
    const dialog = within(await page.findByRole("dialog", { name: i18n.t("ci.rerunSingle") }))
    await userEvent.click(await dialog.findByRole("button", { name: i18n.t("ci.rerunChecks") }))
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith(
        "rerun_check",
        expect.objectContaining({ target: githubRun.retry, mode: "job", jobId: 12 })
      )
    )
  }
}
export const UnavailableChecksCannotRerun: Story = {
  beforeEach: withNativeFixtures({ ...handlers, check_rerun_eligibility: () => [] }),
  play: async ({ canvas }) => {
    await userEvent.click((await canvas.findAllByRole("button", { name: i18n.t("pr.checksDetail") }))[0])
    const page = within(document.body)
    await userEvent.click(await page.findByRole("button", { name: i18n.t("ci.rerun") }))
    await userEvent.click(await page.findByRole("menuitem", { name: i18n.t("ci.rerunFailed") }))
    const dialog = within(await page.findByRole("dialog", { name: i18n.t("ci.rerunFailed") }))
    await expect(await dialog.findByText(i18n.t("ci.noneRerunnable"))).toBeVisible()
    const confirm = dialog.getByRole("button", { name: i18n.t("ci.rerunChecks") })
    await expect(confirm).toHaveAttribute("aria-disabled", "true")
    await userEvent.click(confirm)
    await expect(nativeCall.mock.calls.some(([command]) => command === "rerun_check")).toBe(false)
  }
}
export const RerunFailureIsRetryable: Story = {
  beforeEach: () => {
    let attempts = 0
    return withNativeFixtures({
      ...githubHandlers,
      rerun_check: () => {
        if (++attempts === 1) throw new Error("HTTP 503 temporary failure")
      }
    })()
  },
  args: { remote: githubRemote },
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("button", { name: i18n.t("pr.checksDetail") }))
    const page = within(document.body)
    await userEvent.click(await page.findByRole("button", { name: i18n.t("ci.rerunJob", { name: githubRun.name }) }))
    const dialog = within(await page.findByRole("dialog", { name: i18n.t("ci.rerunSingle") }))
    const confirm = await dialog.findByRole("button", { name: i18n.t("ci.rerunChecks") })
    await userEvent.click(confirm)
    await expect(await dialog.findByRole("alert")).toHaveTextContent("HTTP 503")
    await userEvent.click(confirm)
    await waitFor(() => expect(nativeCall.mock.calls.filter(([command]) => command === "rerun_check")).toHaveLength(2))
  }
}

export const NoSearchResults: Story = {
  play: async ({ canvas }) => {
    await canvas.findByText(request.title)
    await userEvent.type(canvas.getByRole("textbox", { name: i18n.t("pr.search") }), "no-such-request")
    await expect(canvas.getByText(i18n.t("pr.noMatches"))).toBeInTheDocument()
    await expect(canvas.queryByRole("listitem")).not.toBeInTheDocument()
  }
}

export const KeyboardCheckout: Story = {
  play: async ({ canvas, args }) => {
    const row = await canvas.findByRole("listitem", { name: `#42 ${request.title}, ${i18n.t("pr.title")}` })
    row.focus()
    await userEvent.keyboard("{Enter}")
    await expect(args.onCheckout).toHaveBeenCalledWith(request, remote)
  }
}

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
  }),
  play: async ({ canvas, args }) => {
    await canvas.findByRole("listitem", { name: `#1 Request 1, ${i18n.t("pr.title")}` })
    // The production Desktop list must virtualize rather than render 2000 rows.
    await expect(canvas.getAllByRole("listitem").length).toBeLessThan(40)
    await userEvent.type(canvas.getByRole("textbox", { name: i18n.t("pr.search") }), "Request 2000")
    const row = await canvas.findByRole("listitem", { name: `#2000 Request 2000, ${i18n.t("pr.title")}` })
    row.focus()
    await userEvent.keyboard("{Enter}")
    await expect(args.onCheckout).toHaveBeenCalledWith(expect.objectContaining({ number: 2000 }), remote)
  }
}

export const ContextMenuOpensPlatform: Story = {
  play: async ({ canvas, args }) => {
    const row = await canvas.findByRole("listitem", { name: `#42 ${request.title}, ${i18n.t("pr.title")}` })
    await userEvent.pointer({ target: row.querySelector("[data-slot=context-menu-trigger]")!, keys: "[MouseRight]" })
    await userEvent.click(await within(document.body).findByRole("menuitem", { name: i18n.t("pr.viewOnline") }))
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("plugin:opener|open_url", expect.objectContaining({ url: request.url }))
    )
    await expect(args.onCheckout).not.toHaveBeenCalled()
  }
}
