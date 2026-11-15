import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
import { Blame } from "../src/ui/blame/blame"
import { commit, pending, repo, unavailable } from "./fixtures"

const lines = ["const greeting = 'hello'", "console.log(greeting)"].map((content, index) => ({
  line: index + 1,
  sha: commit.sha,
  shortSha: commit.shortSha,
  author: commit.authorName,
  time: commit.time,
  summary: commit.summary,
  content
}))
const meta = {
  title: "History/Blame",
  component: Blame,
  beforeEach: withNativeFixtures({ blame: () => lines }),
  args: { repo, file: "src/main.tsx", onClose: fn(), onSelectCommit: fn() },
  decorators: [
    Story => (
      <div className="h-96">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof Blame>
export default meta
type Story = StoryObj<typeof meta>
export const LinesAndNavigation: Story = {}
export const Loading: Story = { beforeEach: withNativeFixtures({ blame: pending }) }
export const Empty: Story = { beforeEach: withNativeFixtures({ blame: () => [] }) }
export const Failure: Story = {
  beforeEach: withNativeFixtures({ blame: unavailable })
}

export const HundredThousandLines: Story = {
  beforeEach: withNativeFixtures({
    blame: () =>
      Array.from({ length: 100_000 }, (_, index) => ({
        ...lines[0],
        line: index + 1,
        content: `large-file-line-${index + 1}`,
        sha: index === 99_999 ? "d".repeat(40) : commit.sha,
        shortSha: index === 99_999 ? "ddddddd" : commit.shortSha
      }))
  })
}
