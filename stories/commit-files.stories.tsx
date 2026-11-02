import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

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
export const AllStatuses: Story = {}
export const Empty: Story = { args: { files: [], selected: null } }
export const LongPath: Story = {
  args: {
    files: [{ ...files[1], path: "packages/gitcub/features/history/very-long-name-for-a-commit-file-component.tsx" }]
  }
}
