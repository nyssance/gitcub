import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import i18n from "../src/lib/i18n"
import { UnknownAuthors } from "../src/ui/unknown-authors/unknown-authors-dialog"

const meta = {
  title: "Changes/Unknown co-authors",
  component: UnknownAuthors,
  parameters: { layout: "fullscreen" },
  args: {
    authors: [
      { kind: "unknown", username: "ghost-author", state: "error" },
      { kind: "unknown", username: "someone-else", state: "error" }
    ],
    onCommit: fn(),
    onDismissed: fn()
  }
} satisfies Meta<typeof UnknownAuthors>
export default meta
type Story = StoryObj<typeof meta>

/** Desktop UnknownAuthors：列出查不到的用户，「仍然提交」才继续 */
export const CommitAnyway: Story = {
  play: async ({ args }) => {
    const screen = within(document.body)
    await expect(await screen.findByText("ghost-author")).toBeVisible()
    await userEvent.click(screen.getByRole("button", { name: i18n.t("unknownAuthors.commitAnyway") }))
    await expect(args.onCommit).toHaveBeenCalledOnce()
    await expect(args.onDismissed).toHaveBeenCalled()
  }
}

export const CancelDoesNotCommit: Story = {
  play: async ({ args }) => {
    const screen = within(document.body)
    await userEvent.click(await screen.findByRole("button", { name: i18n.t("common.cancel") }))
    await expect(args.onCommit).not.toHaveBeenCalled()
    await expect(args.onDismissed).toHaveBeenCalled()
  }
}

/** 超过 10 位只报数量，不列名单 */
export const ManyAuthors: Story = {
  args: {
    authors: Array.from({ length: 11 }, (_, i) => ({
      kind: "unknown" as const,
      username: `user-${i}`,
      state: "error" as const
    }))
  },
  play: async () => {
    const screen = within(document.body)
    await expect(await screen.findByText(i18n.t("unknownAuthors.countUsersWerentFound", { count: 11 }))).toBeVisible()
    await expect(screen.queryByText("user-0")).not.toBeInTheDocument()
  }
}
