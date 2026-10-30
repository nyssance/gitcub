import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent } from "storybook/test"

import type { CommitFile } from "../src/models/history"
import { CommitFileList } from "../src/ui/history/file-list"

const files: CommitFile[] = ["added", "modified", "deleted", "renamed", "copied"].map((kind, index) => ({
  path: `${kind}-${index}.ts`,
  kind: kind as CommitFile["kind"],
  oldPath: kind === "renamed" ? "old.ts" : null,
  renameIncludesModifications: false,
  submodule: false,
  linesAdded: index,
  linesDeleted: 0
}))
const meta = {
  title: "History/Commit files",
  component: CommitFileList,
  args: { files, selected: files[0].path, onSelect: fn() },
  decorators: [
    Story => (
      <div className="h-72">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof CommitFileList>
export default meta
type Story = StoryObj<typeof meta>
export const AllStatuses: Story = {
  play: async ({ canvas, args }) => {
    await userEvent.click(await canvas.findByText(files[1].path))
    await expect(args.onSelect).toHaveBeenCalledWith(files[1].path)
  }
}
export const Empty: Story = { args: { files: [], selected: null } }
export const LongPath: Story = {
  args: {
    files: [{ ...files[1], path: "packages/gitcub/features/history/very-long-name-for-a-commit-file-component.tsx" }]
  }
}

export const KeyboardNavigation: Story = {
  play: async ({ canvas, args }) => {
    const first = await canvas.findByRole("option", { name: /added-0.ts/ })
    first.focus()
    await userEvent.keyboard("{ArrowDown}")
    await expect(args.onSelect).toHaveBeenCalledWith(files[1].path)
  }
}
