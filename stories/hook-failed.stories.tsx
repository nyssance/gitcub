import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { CommitProgress } from "../src/ui/commit-progress/commit-progress"
import { HookFailed } from "../src/ui/hook-failed/hook-failed"

const meta = {
  title: "Changes/Hook failed",
  component: HookFailed,
  parameters: { layout: "fullscreen" },
  args: {
    hookName: "pre-commit",
    terminalOutput:
      "Running pre-commit hook...\nlint failed: 3 problems\npre-commit hook failed with code 1 after 0.42s\n",
    resolve: fn(),
    onDismissed: fn()
  }
} satisfies Meta<typeof HookFailed>
export default meta
type Story = StoryObj<typeof meta>

/** Desktop HookFailed：「Ignore and Continue」让 git 当钩子成功 */
export const IgnoreAndContinue: Story = {
  play: async ({ args }) => {
    const screen = within(document.body)
    await expect(await screen.findByText("The pre-commit hook failed. What would you like to do?")).toBeVisible()
    await userEvent.click(screen.getByRole("button", { name: "Ignore and Continue" }))
    await expect(args.resolve).toHaveBeenCalledWith("ignore")
    await expect(args.onDismissed).toHaveBeenCalled()
  }
}

/** 「Abort」与关掉对话框一样，钩子按失败处理 */
export const Abort: Story = {
  play: async ({ args }) => {
    const screen = within(document.body)
    await userEvent.click(await screen.findByRole("button", { name: "Abort" }))
    await expect(args.resolve).toHaveBeenCalledWith("abort")
    await expect(args.onDismissed).toHaveBeenCalled()
  }
}

/** Desktop CommitProgress：先回放已有输出，再接着写新到的 */
export const CommitProgressReplaysOutput: Story = {
  render: () => {
    const listeners = new Set<(chunk: string) => void>()
    setTimeout(() => {
      listeners.forEach(listener => {
        listener("pre-commit hook done after 0.10s\r\n")
      })
    }, 50)
    return (
      <CommitProgress
        subscribeToCommitOutput={callback => {
          listeners.add(callback as (chunk: string) => void)
          callback("Running pre-commit hook...\r\n")
          return { unsubscribe: () => listeners.delete(callback as (chunk: string) => void) }
        }}
        onDismissed={fn()}
      />
    )
  },
  play: async () => {
    const screen = within(document.body)
    await expect(await screen.findByText("Committing changes")).toBeInTheDocument()
    await waitFor(() =>
      expect(document.querySelector("#commit-progress-dialog .xterm-rows")?.textContent).toContain(
        "Running pre-commit hook..."
      )
    )
    await waitFor(() =>
      expect(document.querySelector("#commit-progress-dialog .xterm-rows")?.textContent).toContain(
        "pre-commit hook done"
      )
    )
  }
}
