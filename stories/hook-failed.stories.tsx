import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

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
export const Default: Story = {}

/** Desktop CommitProgress：先回放已有输出，再接着写新到的 */
export const Progress: Story = {
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
  }
}

/** 发布仓库、建 PR 这类对话框里推送时 pre-push 失败：HookFailed 叠在上面，照样能选 */
export const OverAnotherDialog: Story = {
  render: args => (
    <>
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish repository</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>
      <HookFailed {...args} hookName="pre-push" />
    </>
  )
}
