import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fireEvent, fn, userEvent } from "storybook/test"

import i18n from "../src/lib/i18n"
import { Conflicts } from "../src/ui/changes/conflicts"
import { file } from "./fixtures"
const conflicted = { ...file, change: "conflicted" as const }
const meta = {
  title: "Changes/Conflict resolution",
  component: Conflicts,
  tags: ["desktop-window"],
  args: {
    operation: "merge",
    files: [conflicted],
    ours: "main",
    theirs: "feature/topic",
    onResolve: fn(),
    onAbort: fn(),
    onContinue: fn()
  }
} satisfies Meta<typeof Conflicts>
export default meta
type Story = StoryObj<typeof meta>
export const UnresolvedMerge: Story = {
  play: async ({ canvas, args }) => {
    await expect(canvas.getByRole("button", { name: i18n.t("conflicts.continue.merge") })).toBeDisabled()
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("conflicts.keep", { branch: "main" }) }))
    await expect(args.onResolve).toHaveBeenCalledWith(conflicted, "ours")
    await expect(args.onContinue).not.toHaveBeenCalled()
  }
}
export const KeepIncoming: Story = {
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("conflicts.keep", { branch: "feature/topic" }) }))
    await expect(args.onResolve).toHaveBeenCalledWith(conflicted, "theirs")
  }
}
export const AbortRebase: Story = {
  args: { operation: "rebase" },
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("conflicts.abort") }))
    await expect(args.onAbort).toHaveBeenCalledWith("rebase")
  }
}
export const ResolvedMerge: Story = {
  args: { files: [] },
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("conflicts.continue.merge") }))
    await expect(args.onContinue).toHaveBeenCalledWith("merge")
  }
}
export const ResolvedRebase: Story = {
  ...ResolvedMerge,
  args: { operation: "rebase", files: [] },
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("conflicts.continue.rebase") }))
    await expect(args.onContinue).toHaveBeenCalledWith("rebase")
  }
}
export const Inactive: Story = {
  args: { operation: null },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("button")).not.toBeInTheDocument()
  }
}

export const BusyPreventsRepeatedOperations: Story = {
  args: { busy: true },
  play: async ({ canvas, args }) => {
    for (const button of canvas.getAllByRole("button")) {
      await expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    await expect(args.onResolve).not.toHaveBeenCalled()
    await expect(args.onAbort).not.toHaveBeenCalled()
    await expect(args.onContinue).not.toHaveBeenCalled()
  }
}
export const RebaseSides: Story = {
  args: { operation: "rebase" },
  play: async ({ canvas, args }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: i18n.t("conflicts.keep", { branch: i18n.t("conflicts.rebaseBase") }) })
    )
    await expect(args.onResolve).toHaveBeenLastCalledWith(conflicted, "ours")
    await userEvent.click(
      canvas.getByRole("button", { name: i18n.t("conflicts.keep", { branch: i18n.t("conflicts.rebaseCommit") }) })
    )
    await expect(args.onResolve).toHaveBeenLastCalledWith(conflicted, "theirs")
  }
}
const deleted = {
  ...conflicted,
  conflict: { hasBase: true, hasOurs: true, hasTheirs: false, markers: 0, binary: false }
}
export const ModifyDelete: Story = {
  args: { files: [deleted] },
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("conflicts.drop", { branch: "feature/topic" }) }))
    await expect(args.onResolve).toHaveBeenCalledWith(deleted, "theirs")
    await expect(canvas.getByRole("button", { name: i18n.t("conflicts.continue.merge") })).toBeDisabled()
  }
}
export const ResolvedCherryPick: Story = {
  args: { operation: "cherry-pick", files: [] },
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("conflicts.continue.cherry-pick") }))
    await expect(args.onContinue).toHaveBeenCalledWith("cherry-pick")
  }
}
export const ResolvedRevert: Story = {
  args: { operation: "revert", files: [] },
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("conflicts.continue.revert") }))
    await expect(args.onContinue).toHaveBeenCalledWith("revert")
  }
}
