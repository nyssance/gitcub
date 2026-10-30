import type { Meta, StoryObj } from "@storybook/react-vite"

import { BranchListItem } from "../src/ui/branches/branch-list-item"

const meta = {
  title: "Branches/Branch row",
  component: BranchListItem,
  args: { name: "main", isCurrentBranch: true, matches: { title: [], subtitle: [] }, authorDate: undefined },
  decorators: [
    Story => (
      <div style={{ width: "min(100%, 360px)" }}>
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof BranchListItem>
export default meta
type Story = StoryObj<typeof meta>
export const Current: Story = {}
export const Feature: Story = { args: { name: "feature/gitlab-subgroups", isCurrentBranch: false } }
export const SearchMatch: Story = {
  args: {
    name: "feature/gitlab-subgroups",
    isCurrentBranch: false,
    matches: { title: [8, 9, 10, 11, 12, 13], subtitle: [] }
  }
}
export const LongName: Story = {
  args: {
    name: "feature/support-self-hosted-gitlab-nested-subgroups-and-enterprise-authentication",
    isCurrentBranch: false
  }
}
