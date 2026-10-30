import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
import { Button } from "../src/ui/base/button"
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
  tags: ["desktop-window"],
  beforeEach: withNativeFixtures({ blame: () => lines }),
  afterEach: assertNativeFixtures,
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
export const LinesAndNavigation: Story = {
  play: async ({ canvas, args }) => {
    await expect(await canvas.findByText(lines[1].content)).toBeVisible()
    await userEvent.click(canvas.getAllByRole("button", { name: `${commit.shortSha} ${commit.authorName}` })[0])
    await expect(args.onSelectCommit).toHaveBeenCalledWith(commit.sha)
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("common.close") }))
    await expect(args.onClose).toHaveBeenCalledTimes(1)
  }
}
export const Loading: Story = { beforeEach: withNativeFixtures({ blame: pending }) }
export const Empty: Story = { beforeEach: withNativeFixtures({ blame: () => [] }) }
export const Failure: Story = {
  beforeEach: withNativeFixtures({ blame: unavailable }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Preview service unavailable/)).toBeVisible()
  }
}

let oldBlame: ReturnType<typeof Promise.withResolvers<typeof lines>>
const nextLines = [{ ...lines[0], content: "new file content", sha: "c".repeat(40), shortSha: "ccccccc" }]
function SwitchingBlame(args: ComponentProps<typeof Blame>) {
  const [file, setFile] = useState(args.file)
  return (
    <>
      <Button onClick={() => setFile("src/next.tsx")}>Switch file</Button>
      <Blame {...args} file={file} />
    </>
  )
}
function delayedBlame() {
  oldBlame = Promise.withResolvers<typeof lines>()
  return withNativeFixtures({
    blame: args => ((args as { file: string }).file === "src/main.tsx" ? oldBlame.promise : nextLines)
  })()
}
async function verifyBlameRace(canvas: ReturnType<typeof within>, fail: boolean) {
  await waitFor(() => expect(nativeCall).toHaveBeenCalledWith("blame", { repo, file: "src/main.tsx" }))
  await userEvent.click(canvas.getByRole("button", { name: "Switch file" }))
  await expect(await canvas.findByText("new file content")).toBeVisible()
  if (fail) oldBlame.reject(new Error("Old file failed"))
  else oldBlame.resolve(lines)
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  await expect(canvas.getByText("new file content")).toBeVisible()
  await expect(canvas.queryByText(lines[0].content)).not.toBeInTheDocument()
  await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
}
export const IgnoreLateFileResult: Story = {
  beforeEach: delayedBlame,
  render: args => <SwitchingBlame {...args} />,
  play: async ({ canvas }) => verifyBlameRace(canvas, false)
}
export const IgnoreLateFileError: Story = {
  beforeEach: delayedBlame,
  render: args => <SwitchingBlame {...args} />,
  play: async ({ canvas }) => verifyBlameRace(canvas, true)
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
  }),
  play: async ({ canvas, args }) => {
    await canvas.findByText("large-file-line-1")
    await expect(canvas.queryAllByText(/^large-file-line-/).length).toBeLessThan(100)
    const viewport = canvas.getByRole("region", { name: i18n.t("blame.title") })
    viewport.scrollTop = viewport.scrollHeight
    viewport.dispatchEvent(new Event("scroll"))
    const last = await canvas.findByText("large-file-line-100000")
    await expect(last).toBeVisible()
    await expect(canvas.queryAllByText(/^large-file-line-/).length).toBeLessThan(100)
    await expect(canvas.queryByText("large-file-line-1")).not.toBeInTheDocument()
    await userEvent.click(within(last.parentElement!).getByRole("button"))
    await expect(args.onSelectCommit).toHaveBeenCalledWith("d".repeat(40))
  }
}
