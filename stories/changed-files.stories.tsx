import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { fn } from "storybook/test"

import { ChangesFileList } from "../src/ui/changes/file-list"
import { DiffSelectionType } from "../src/upstream/models/diff"
import { file } from "./fixtures"
const files = ["first.ts", "second.ts", "third.ts"].map(path => ({ ...file, path }))
const meta = {
  title: "Changes/File list",
  component: ChangesFileList,
  args: {
    repo: "/preview/repository",
    files,
    selected: files[0].path,
    includeOf: (_path: string): DiffSelectionType => DiffSelectionType.All,
    onSelect: fn(),
    onIncludeChange: fn(),
    onDiscard: fn(),
    onBlame: fn()
  },
  render: args => {
    const [selected, select] = useState(args.selected)
    const [selectedPaths, selectPaths] = useState(args.selected ? [args.selected] : [])
    return (
      <ChangesFileList
        {...args}
        selected={selected}
        selectedPaths={selectedPaths}
        onSelectionChange={paths => {
          selectPaths(paths)
          const path = paths.at(-1) ?? null
          select(path)
          if (path) args.onSelect(path)
        }}
        onSelect={path => {
          select(path)
          args.onSelect(path)
        }}
      />
    )
  },
  decorators: [
    Story => (
      <div className="h-72">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof ChangesFileList>
export default meta
type Story = StoryObj<typeof meta>
export const PartialInclusion: Story = { args: { includeOf: () => DiffSelectionType.Partial } }
export const TenThousandFiles: Story = {
  args: { files: Array.from({ length: 10000 }, (_, i) => ({ ...file, path: `file-${i}.ts` })), selected: "file-0.ts" }
}

export const MultipleSelection: Story = {
  args: { onDiscardMany: fn() }
}
