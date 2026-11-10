import type { Meta, StoryObj } from "@storybook/react-vite"

import { withNativeFixtures } from "../.storybook/mocks/native"
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
const translate = (key: string, options?: Record<string, string>) => i18n.t(key, options ?? {})

// Desktop's RichText with GitLens autolink reference sets applied after the tokenizer.
const meta = {
  title: "History/Rich text",
  component: RichText,
  beforeEach: withNativeFixtures({ "plugin:opener|open_url": () => undefined }),
  args: {
    emoji: new Map(),
    text: "Fixes JIRA-123 :tada: see https://example.com/notes and !12",
    autolinks: autolinkRefSets([jira], gitlab, "gitlab", translate)
  }
} satisfies Meta<typeof RichText>
export default meta
type Story = StoryObj<typeof meta>

export const CustomRuleAndGitLab: Story = {}

export const WithoutRules: Story = {
  args: { autolinks: [] }
}

export const LinksDisabled: Story = {
  args: { renderUrlsAsLinks: false }
}
