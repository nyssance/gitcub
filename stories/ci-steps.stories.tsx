import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent } from "storybook/test"

import { APICheckConclusion, APICheckStatus, type IAPIWorkflowJobStep } from "../src/lib/api"
import { CICheckRunActionsJobStepList } from "../src/ui/check-runs/ci-check-run-actions-job-step-list"

const steps: IAPIWorkflowJobStep[] = ["Checkout", "Typecheck", "Build"].map((name, index) => ({
  name,
  number: index + 1,
  status: APICheckStatus.Completed,
  conclusion: APICheckConclusion.Success,
  started_at: "2026-01-01T12:00:00Z",
  completed_at: "2026-01-01T12:00:10Z",
  log: ""
}))
const meta = {
  title: "CI/Job steps",
  component: CICheckRunActionsJobStepList,
  args: { steps, onViewJobStep: fn() }
} satisfies Meta<typeof CICheckRunActionsJobStepList>
export default meta
type Story = StoryObj<typeof meta>
export const Success: Story = {}
export const Failure: Story = {
  args: {
    steps: steps.map((step, index) => ({
      ...step,
      conclusion:
        index === 1 ? APICheckConclusion.Failure : index === 2 ? APICheckConclusion.Skipped : APICheckConclusion.Success
    }))
  }
}
export const Running: Story = {
  args: { steps: [{ ...steps[0], status: APICheckStatus.InProgress, conclusion: null, completed_at: "" }] }
}
export const Empty: Story = { args: { steps: [] } }
export const OpenStepOnPlatform: Story = {
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getAllByRole("link")[1])
    await expect(args.onViewJobStep).toHaveBeenCalledWith(steps[1])
  }
}
