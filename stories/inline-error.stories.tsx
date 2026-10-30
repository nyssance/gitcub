import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import { Input } from "../src/ui/base/input"
import { TooltipProvider } from "../src/ui/base/tooltip"
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

export const RateLimited: Story = {
  play: async ({ canvas }) => {
    const alert = canvas.getByRole("alert")
    const box = alert.getBoundingClientRect()
    await expect(box.height).toBeLessThan(45)
    const summary = canvas.getByRole("textbox", { name: "Commit summary" }).getBoundingClientRect()
    await expect(summary.x - box.x).toBe(12)
    await expect(summary.y - box.bottom).toBe(12)
  }
}
export const LongError: Story = {
  args: { error: `Unable to read repository: ${"a-long-path/".repeat(30)}` },
  play: RateLimited.play
}
