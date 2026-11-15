import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { UnknownAuthors } from "../src/ui/unknown-authors/unknown-authors-dialog"

const meta = {
  title: "Changes/Unknown co-authors",
  component: UnknownAuthors,
  parameters: { layout: "fullscreen" },
  args: {
    authors: [
      { kind: "unknown", username: "ghost-author", state: "error" },
      { kind: "unknown", username: "someone-else", state: "error" }
    ],
    onCommit: fn(),
    onDismissed: fn()
  }
} satisfies Meta<typeof UnknownAuthors>
export default meta
type Story = StoryObj<typeof meta>

/** Desktop UnknownAuthors：列出查不到的用户，「仍然提交」才继续 */
export const Default: Story = {}

/** 超过 10 位只报数量，不列名单 */
export const ManyAuthors: Story = {
  args: {
    authors: Array.from({ length: 11 }, (_, i) => ({
      kind: "unknown" as const,
      username: `user-${i}`,
      state: "error" as const
    }))
  }
}
