import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
import { CommitSummary } from "../src/ui/history/commit-summary"
import { commit } from "./fixtures"

const meta = {
  title: "History/Commit summary",
  component: CommitSummary,
  beforeEach: withNativeFixtures({ "plugin:opener|open_url": () => undefined }),
  afterEach: assertNativeFixtures,
  args: { commit, remote: { host: "github.com", owner: "gitcub", name: "gitcub" } }
} satisfies Meta<typeof CommitSummary>
export default meta
type Story = StoryObj<typeof meta>
export const GitHubIssueLinks: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "#42" }))
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith(
        "plugin:opener|open_url",
        expect.objectContaining({ url: "https://github.com/gitcub/gitcub/issues/42" })
      )
    )
    await expect(canvas.queryByRole("link", { name: "#5" })).not.toBeInTheDocument()
  }
}
// GitLab remotes use the GitLens built-in `#<num>` / `!<num>` references (`/-/issues`, `/-/merge_requests`).
export const GitLabSubgroup: Story = {
  args: {
    remote: { host: "gitlab.example", owner: "group/subgroup", name: "project" },
    platform: "gitlab",
    commit: { ...commit, body: "Merge !12 after #123; literal abc#5." }
  },
  play: async ({ canvas }) => {
    const issue = canvas.getByRole("link", { name: "#42" })
    await expect(issue).toHaveAttribute("title", i18n.t("autolinks.gitlabIssue", { num: "42" }))
    await userEvent.click(issue)
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith(
        "plugin:opener|open_url",
        expect.objectContaining({ url: "https://gitlab.example/group/subgroup/project/-/issues/42" })
      )
    )
    const mergeRequest = canvas.getByRole("link", { name: "!12" })
    await expect(mergeRequest).toHaveAttribute(
      "href",
      "https://gitlab.example/group/subgroup/project/-/merge_requests/12"
    )
    await expect(mergeRequest).toHaveAttribute("title", i18n.t("autolinks.gitlabMergeRequest", { num: "12" }))
    await expect(canvas.queryByRole("link", { name: "#5" })).not.toBeInTheDocument()
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
  },
  play: async ({ canvas }) => {
    const link = canvas.getByRole("link", { name: "JIRA-123" })
    await expect(link).toHaveAttribute("href", "https://jira.example.com/browse/JIRA-123")
    await expect(link).toHaveAttribute("title", "Issue 123")
    await expect(canvas.getByRole("link", { name: "jira-7" })).toHaveAttribute(
      "href",
      "https://jira.example.com/browse/JIRA-7"
    )
    await expect(canvas.getByRole("link", { name: "#42" })).toHaveAttribute(
      "href",
      "https://github.com/gitcub/gitcub/issues/42"
    )
    await expect(canvas.queryByRole("link", { name: "!12" })).not.toBeInTheDocument()
  }
}
export const LocalRepository: Story = {
  args: { remote: null },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("link")).not.toBeInTheDocument()
  }
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
