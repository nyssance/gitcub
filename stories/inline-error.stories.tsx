import type { Meta, StoryObj } from "@storybook/react-vite"

import { Input } from "@/components/ui/input"
import { TooltipProvider } from "@/components/ui/tooltip"

import { InlineError } from "../src/ui/shared/inline-error"

const meta = {
  title: "Changes/Inline error",
  component: InlineError,
  decorators: [
    Story => (
      <TooltipProvider>
        <div className="flex w-64 max-w-full flex-col">
          <Story />
          <div className="p-3">
            <Input aria-label="Commit summary" placeholder="Summary" />
          </div>
        </div>
      </TooltipProvider>
    )
  ],
  args: {
    error: `github.com 账号验证失败：HTTP 403 Forbidden: API rate limit exceeded. ${"Diagnostic details. ".repeat(20)}`
  }
} satisfies Meta<typeof InlineError>
export default meta
type Story = StoryObj<typeof meta>

export const RateLimited: Story = {}
export const LongError: Story = {
  args: { error: `Unable to read repository: ${"a-long-path/".repeat(30)}` }
}
