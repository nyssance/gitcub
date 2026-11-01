import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, within } from "storybook/test"

import { APICheckConclusion, APICheckStatus } from "../src/lib/api"
import type { IRefCheck } from "../src/lib/ci-checks/ci-checks"
import { Button } from "@/components/ui/button"
import { CICheckRunList } from "../src/ui/check-runs/ci-check-run-list"

const run: IRefCheck = {
  id: 1,
  name: "Build",
  description: "Failed",
  appName: "GitHub Actions",
  status: APICheckStatus.Completed,
  conclusion: APICheckConclusion.Failure,
  checkSuiteId: 1,
  htmlUrl: "https://github.com/example/project/actions/runs/1",
  actionJobSteps: [
    {
      name: "Compile",
      number: 1,
      status: APICheckStatus.Completed,
      conclusion: APICheckConclusion.Failure,
      started_at: "",
      completed_at: "",
      log: ""
    }
  ]
}
function RefreshChecks() {
  const [runs, setRuns] = useState<readonly IRefCheck[]>([run])
  return (
    <div className="desktop-ci-popover">
      <div className="flex gap-2">
        <Button
          onClick={() =>
            setRuns([
              { ...run, actionJobSteps: [{ ...run.actionJobSteps![0], name: "Updated step" }] },
              { ...run, id: 2, name: "New job" }
            ])
          }>
          Refresh fixture
        </Button>
        <Button onClick={() => setRuns([{ ...run, id: 2, name: "New job" }])}>Remove fixture</Button>
      </div>
      <CICheckRunList checkRuns={runs} />
    </div>
  )
}
const meta = { title: "CI/Refresh", component: RefreshChecks } satisfies Meta<typeof RefreshChecks>
export default meta
type Story = StoryObj<typeof meta>
export const PreservesUserExpansion: Story = {
  play: async ({ canvas }) => {
    const build = canvas.getByRole("button", { name: /Build/ })
    await expect(build).toHaveAttribute("aria-expanded", "true")
    await userEvent.click(build)
    await userEvent.click(canvas.getByRole("button", { name: "Refresh fixture" }))
    await expect(canvas.getByRole("button", { name: /Build/ })).toHaveAttribute("aria-expanded", "false")
    await expect(canvas.getByRole("button", { name: /New job/ })).toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: /Build/ }))
    await expect(within(canvas.getByRole("region", { name: "Build" })).getByText("Updated step")).toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Remove fixture" }))
    await expect(canvas.queryByRole("button", { name: /Build/ })).not.toBeInTheDocument()
    await expect(canvas.getByRole("button", { name: /New job/ })).toHaveAttribute("aria-expanded", "false")
  }
}
