import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
import { Tags } from "../src/ui/history/tags"
import { repo, unavailable } from "./fixtures"
const handlers = {
  tags: () => ["v1.0", "v2.0-beta"],
  remotes: () => [["origin", "https://github.com/gitcub/gitcub.git"]],
  push: () => undefined
}
const meta = {
  title: "History/Tags",
  component: Tags,
  tags: ["desktop-window"],
  beforeEach: withNativeFixtures(handlers),
  afterEach: assertNativeFixtures,
  args: { repo }
} satisfies Meta<typeof Tags>
export default meta
type Story = StoryObj<typeof meta>
async function openTags() {
  const screen = within(document.body)
  await userEvent.click(screen.getByRole("button", { name: i18n.t("tags.title") }))
  return within(await screen.findByRole("dialog"))
}
export const SearchAndPush: Story = {
  play: async () => {
    const dialog = await openTags()
    await dialog.findByText("v2.0-beta")
    await userEvent.type(dialog.getByRole("textbox", { name: i18n.t("tags.search") }), "v2")
    await expect(dialog.queryByText("v1.0")).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole("button", { name: i18n.t("tags.push") }))
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("push", {
        repo,
        remote: "origin",
        refspec: "refs/tags/v2.0-beta:refs/tags/v2.0-beta",
        setUpstream: false,
        forceWithLease: false
      })
    )
  }
}
export const CancelDeletion: Story = {
  beforeEach: withNativeFixtures({ ...handlers, "plugin:dialog|message": () => "Cancel" }),
  play: async () => {
    const dialog = await openTags()
    await dialog.findByText("v1.0")
    await userEvent.click(dialog.getAllByRole("button", { name: i18n.t("tags.deleteLocal") })[0])
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("plugin:dialog|message", expect.objectContaining({ kind: "warning" }))
    )
    await expect(nativeCall.mock.calls.some(([command]) => command === "delete_tag")).toBe(false)
  }
}
export const NoTags: Story = {
  beforeEach: withNativeFixtures({ ...handlers, tags: () => [] }),
  play: async () => {
    const dialog = await openTags()
    await expect(await dialog.findByText(i18n.t("tags.empty"))).toBeVisible()
  }
}
export const FailedLoad: Story = {
  beforeEach: withNativeFixtures({ ...handlers, tags: unavailable }),
  play: async () => {
    const dialog = await openTags()
    await expect(await dialog.findByRole("alert")).toHaveTextContent("Preview service unavailable")
  }
}

export const Loading: Story = {
  beforeEach: withNativeFixtures({ ...handlers, tags: () => new Promise<never>(() => {}) }),
  play: async () => {
    const dialog = await openTags()
    await expect(await dialog.findByRole("status", { name: i18n.t("tags.loading") })).toBeVisible()
    await expect(dialog.getByRole("button", { name: i18n.t("inbox.refresh") })).toBeDisabled()
    await expect(dialog.queryByText(i18n.t("tags.empty"))).not.toBeInTheDocument()
  }
}
export const NoMatches: Story = {
  play: async () => {
    const dialog = await openTags()
    await dialog.findByText("v1.0")
    await userEvent.type(dialog.getByRole("textbox", { name: i18n.t("tags.search") }), "missing")
    await expect(await dialog.findByText(i18n.t("tags.noMatch"))).toBeVisible()
    await expect(dialog.getByText("0/2")).toBeVisible()
  }
}
export const RetryLoad: Story = {
  beforeEach: () => {
    let attempts = 0
    return withNativeFixtures({ ...handlers, tags: () => (++attempts === 1 ? unavailable() : handlers.tags()) })()
  },
  play: async () => {
    const dialog = await openTags()
    await expect(await dialog.findByRole("alert")).toHaveTextContent("Preview service unavailable")
    const retry = dialog.getByRole("button", { name: i18n.t("inbox.refresh") })
    await waitFor(() => expect(retry).toBeEnabled())
    await userEvent.click(retry)
    await expect(await dialog.findByText("v1.0")).toBeVisible()
    await expect(dialog.queryByRole("alert")).not.toBeInTheDocument()
  }
}
export const FailedConfirmation: Story = {
  beforeEach: withNativeFixtures({ ...handlers, "plugin:dialog|message": unavailable }),
  play: async () => {
    const dialog = await openTags()
    await dialog.findByText("v1.0")
    const remove = dialog.getAllByRole("button", { name: i18n.t("tags.deleteLocal") })[0]
    await userEvent.click(remove)
    await expect(await dialog.findByRole("alert")).toHaveTextContent("Preview service unavailable")
    await expect(remove).toBeEnabled()
    await expect(nativeCall.mock.calls.some(([command]) => command === "delete_tag")).toBe(false)
  }
}
let finishConfirmation: (value: string) => void
export const PendingConfirmation: Story = {
  beforeEach: withNativeFixtures({
    ...handlers,
    "plugin:dialog|message": () =>
      new Promise<string>(resolve => {
        finishConfirmation = resolve
      })
  }),
  play: async () => {
    const dialog = await openTags()
    await dialog.findByText("v1.0")
    const remove = dialog.getAllByRole("button", { name: i18n.t("tags.deleteLocal") })[0]
    await userEvent.dblClick(remove)
    await waitFor(() =>
      expect(nativeCall.mock.calls.filter(([command]) => command === "plugin:dialog|message")).toHaveLength(1)
    )
    await expect(remove).toBeDisabled()
    await expect(dialog.getByRole("combobox")).toBeDisabled()
    await userEvent.keyboard("{Escape}")
    await expect(within(document.body).getByRole("dialog")).toBeVisible()
    finishConfirmation("Cancel")
    await waitFor(() => expect(remove).toBeEnabled())
    await expect(nativeCall.mock.calls.some(([command]) => command === "delete_tag")).toBe(false)
  }
}
export const DeleteRemote: Story = {
  beforeEach: withNativeFixtures({ ...handlers, "plugin:dialog|message": () => "Ok" }),
  play: async () => {
    const dialog = await openTags()
    await dialog.findByText("v1.0")
    await userEvent.click(dialog.getAllByRole("button", { name: i18n.t("tags.deleteRemote") })[0])
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("push", {
        repo,
        remote: "origin",
        refspec: ":refs/tags/v1.0",
        setUpstream: false,
        forceWithLease: false
      })
    )
    await expect(nativeCall.mock.calls.some(([command]) => command === "delete_tag")).toBe(false)
  }
}

export const DeleteLocal: Story = {
  beforeEach: () => {
    let removed = false
    return withNativeFixtures({
      ...handlers,
      tags: () => (removed ? ["v2.0-beta"] : handlers.tags()),
      "plugin:dialog|message": () => "Ok",
      delete_tag: () => {
        removed = true
      }
    })()
  },
  play: async () => {
    const dialog = await openTags()
    await dialog.findByText("v1.0")
    await userEvent.click(dialog.getAllByRole("button", { name: i18n.t("tags.deleteLocal") })[0])
    await waitFor(() => expect(nativeCall).toHaveBeenCalledWith("delete_tag", { repo, name: "v1.0" }))
    await expect(await dialog.findByText("v2.0-beta")).toBeVisible()
    await waitFor(() => expect(dialog.queryByText("v1.0")).not.toBeInTheDocument())
    await expect(nativeCall.mock.calls.some(([command]) => command === "push")).toBe(false)
  }
}
