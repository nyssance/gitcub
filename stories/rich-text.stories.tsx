import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import { autolinkRefSets } from "../src/lib/autolink-rules"
import i18n from "../src/lib/i18n"
import { RichText } from "../src/ui/desktop/rich-text"

const jira = {
  prefix: "JIRA-",
  url: "https://jira.example.com/browse/JIRA-<num>",
  alphanumeric: false,
  ignoreCase: false,
  title: "Issue <num>"
}
const gitlab = { host: "gitlab.example", owner: "group/subgroup", name: "project" }
const translate = (key: string, options?: Record<string, string>) => i18n.t(key, options)

// Desktop's RichText with GitLens autolink reference sets applied after the tokenizer.
const meta = {
  title: "History/Rich text",
  component: RichText,
  beforeEach: withNativeFixtures({ "plugin:opener|open_url": () => undefined }),
  afterEach: assertNativeFixtures,
  args: {
    emoji: new Map(),
    text: "Fixes JIRA-123 :tada: see https://example.com/notes and !12",
    autolinks: autolinkRefSets([jira], gitlab, "gitlab", translate)
  }
} satisfies Meta<typeof RichText>
export default meta
type Story = StoryObj<typeof meta>

export const CustomRuleAndGitLab: Story = {
  play: async ({ canvas }) => {
    const issue = canvas.getByRole("link", { name: "JIRA-123" })
    await expect(issue).toHaveAttribute("href", "https://jira.example.com/browse/JIRA-123")
    await userEvent.click(issue)
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith(
        "plugin:opener|open_url",
        expect.objectContaining({ url: "https://jira.example.com/browse/JIRA-123" })
      )
    )
    await expect(canvas.getByRole("link", { name: "!12" })).toHaveAttribute(
      "href",
      "https://gitlab.example/group/subgroup/project/-/merge_requests/12"
    )
    await expect(canvas.getByRole("link", { name: "https://example.com/notes" })).toBeVisible()
  }
}

export const WithoutRules: Story = {
  args: { autolinks: [] },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("link", { name: "JIRA-123" })).not.toBeInTheDocument()
    await expect(canvas.getByRole("link", { name: "https://example.com/notes" })).toBeVisible()
  }
}

export const LinksDisabled: Story = {
  args: { renderUrlsAsLinks: false },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("link")).not.toBeInTheDocument()
    await expect(canvas.getByText("JIRA-123")).toBeVisible()
  }
}
