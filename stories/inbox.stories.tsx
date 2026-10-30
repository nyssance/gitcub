import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
import { Inbox } from "../src/ui/inbox/inbox"
import { file, pending, repo, status, unavailable } from "./fixtures"

const meta = {
  title: "Collaboration/Inbox",
  component: Inbox,
  tags: ["desktop-window"],
  beforeEach: withNativeFixtures({ repo_status: () => status }),
  afterEach: assertNativeFixtures,
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
export const Clear: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(i18n.t("inbox.clear"))).toBeVisible()
  }
}
export const LocalActions: Story = {
  beforeEach: withNativeFixtures({
    repo_status: () => ({ ...status, ahead: 2, changes: [{ ...file, change: "conflicted" }] })
  }),
  play: async ({ canvas, args }) => {
    await expect(await canvas.findByText(i18n.t("inbox.conflict", { count: 1 }))).toBeVisible()
    await expect(canvas.getByText(i18n.t("inbox.unpushed", { count: 2 }))).toBeVisible()
    await userEvent.click(canvas.getAllByRole("button", { name: i18n.t("inbox.go") })[0])
    await expect(args.onOpenRepo).toHaveBeenCalledWith(repo)
  }
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
  }),
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("button", { name: i18n.t("inbox.go") }))
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith(
        "plugin:opener|open_url",
        expect.objectContaining({ url: "https://gitlab.example/group/sub/project/-/merge_requests/42" })
      )
    )
  }
}
export const Loading: Story = { beforeEach: withNativeFixtures({ repo_status: pending }) }
export const FailureAndRetry: Story = {
  beforeEach: () => {
    let attempts = 0
    return withNativeFixtures({ repo_status: () => (++attempts === 1 ? unavailable() : status) })()
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Preview service unavailable")
    await expect(canvas.queryByText(i18n.t("inbox.clear"))).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("inbox.refresh") }))
    await expect(await canvas.findByText(i18n.t("inbox.clear"))).toBeVisible()
  }
}
