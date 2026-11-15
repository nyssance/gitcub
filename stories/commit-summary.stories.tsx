import type { Meta, StoryObj } from "@storybook/react-vite"

import { withNativeFixtures } from "../.storybook/mocks/native"
import { CommitSummary } from "../src/ui/history/commit-summary"
import { commit } from "./fixtures"

const meta = {
  title: "History/Commit summary",
  component: CommitSummary,
  beforeEach: withNativeFixtures({ "plugin:opener|open_url": () => undefined }),
  args: { commit, remote: { host: "github.com", owner: "gitcub", name: "gitcub" } }
} satisfies Meta<typeof CommitSummary>
export default meta
type Story = StoryObj<typeof meta>
export const GitHubIssueLinks: Story = {}
// GitLab remotes use the GitLens built-in `#<num>` / `!<num>` references (`/-/issues`, `/-/merge_requests`).
export const GitLabSubgroup: Story = {
  args: {
    remote: { host: "gitlab.example", owner: "group/subgroup", name: "project" },
    platform: "gitlab",
    commit: { ...commit, body: "Merge !12 after #123; literal abc#5." }
  }
}
// A rule from Settings › Advanced linkifies on any remote; GitHub keeps Desktop's `#<num>` handling.
export const CustomRule: Story = {
  args: {
    rules: [
      {
        prefix: "JIRA-",
        url: "https://jira.example.com/browse/JIRA-<num>",
        alphanumeric: false,
        ignoreCase: true,
        title: "Issue <num>"
      }
    ],
    commit: { ...commit, summary: "Fix issue #42 (JIRA-123)", body: "Also jira-7 and !12 stay as text on GitHub." }
  }
}
export const LocalRepository: Story = {
  args: { remote: null }
}
export const LongMessage: Story = {
  args: {
    commit: {
      ...commit,
      summary: "修复自建 GitLab 实例多层子组与 GitHub Enterprise 的提交链接显示 #42",
      body: "A long commit body\n".repeat(12)
    }
  }
}
