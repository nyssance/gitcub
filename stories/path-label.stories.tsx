import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import { PathLabel } from "../src/ui/desktop/path-label"
import { AppFileStatusKind } from "../src/upstream/models/status"

const meta = {
  title: "Changes/File path",
  component: PathLabel,
  args: { path: "src/main.tsx", status: { kind: AppFileStatusKind.Modified }, availableWidth: 360 }
} satisfies Meta<typeof PathLabel>
export default meta
type Story = StoryObj<typeof meta>
export const Modified: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText("main.tsx")).toBeVisible()
  }
}
export const Renamed: Story = {
  args: {
    status: { kind: AppFileStatusKind.Renamed, oldPath: "src/application.tsx", renameIncludesModifications: true }
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("application.tsx")).toBeVisible()
    const oldPath = canvas.getByText("application.tsx").getBoundingClientRect()
    const newPath = canvas.getByText("main.tsx").getBoundingClientRect()
    await expect(Math.abs(oldPath.y - newPath.y)).toBeLessThan(1)
    await expect(canvas.getByText("main.tsx")).toBeVisible()
  }
}
export const LongPath: Story = {
  args: { path: "packages/gitcub/features/repository/history/components/commit-details.tsx", availableWidth: 220 }
}
export const Unicode: Story = { args: { path: "文档/协作流程/合并请求.md", availableWidth: 240 } }
