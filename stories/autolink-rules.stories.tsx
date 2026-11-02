import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { AutolinkRules } from "../src/ui/preferences/autolink-rules"

const jira = {
  prefix: "JIRA-",
  url: "https://jira.example.com/browse/JIRA-<num>",
  alphanumeric: false,
  ignoreCase: true,
  title: "Issue <num>"
}

const meta = {
  title: "Settings/Autolink rules",
  component: AutolinkRules,
  args: { rules: [jira], onChange: fn() },
  decorators: [
    Story => (
      <div className="w-[640px] px-4">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof AutolinkRules>
export default meta
type Story = StoryObj<typeof meta>

export const Rules: Story = {}

export const Empty: Story = {
  args: { rules: [] }
}
