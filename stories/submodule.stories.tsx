import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
import { Button } from "@/components/ui/button"
import { SubmoduleView } from "../src/ui/diff/submodule"
import { file, pending, repo, unavailable } from "./fixtures"

const info = {
  fullPath: `${repo}/vendor/library`,
  url: "https://gitlab.example/group/library.git",
  recorded: "aaaaaaa",
  actual: "bbbbbbb",
  dirty: 3
}
const meta = {
  title: "Diff/Submodule",
  component: SubmoduleView,
  beforeEach: withNativeFixtures({ submodule_info: () => info }),
  afterEach: assertNativeFixtures,
  args: { repo, file: { ...file, path: "vendor/library" }, onOpen: fn() }
} satisfies Meta<typeof SubmoduleView>
export default meta
type Story = StoryObj<typeof meta>
export const ChangedAndDirty: Story = {
  play: async ({ canvas, args }) => {
    await expect(await canvas.findByText(i18n.t("submodule.dirty", { count: 3 }))).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("submodule.open") }))
    await expect(args.onOpen).toHaveBeenCalledWith(info.fullPath)
  }
}
export const Clean: Story = {
  beforeEach: withNativeFixtures({ submodule_info: () => ({ ...info, actual: info.recorded, dirty: 0 }) })
}
export const Loading: Story = { beforeEach: withNativeFixtures({ submodule_info: pending }) }
export const Failure: Story = {
  beforeEach: withNativeFixtures({ submodule_info: unavailable }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Preview service unavailable/)).toBeVisible()
  }
}

let oldSubmodule: ReturnType<typeof Promise.withResolvers<typeof info>>
const nextInfo = { ...info, fullPath: `${repo}/vendor/next`, url: "https://gitlab.example/group/next.git" }
function SwitchingSubmodule(args: ComponentProps<typeof SubmoduleView>) {
  const [path, setPath] = useState(args.file.path)
  return (
    <>
      <Button onClick={() => setPath("vendor/next")}>Switch submodule</Button>
      <SubmoduleView {...args} file={{ ...args.file, path }} />
    </>
  )
}
export const IgnoreLateSubmodule: Story = {
  beforeEach: () => {
    oldSubmodule = Promise.withResolvers<typeof info>()
    return withNativeFixtures({
      submodule_info: args => ((args as { file: string }).file === "vendor/library" ? oldSubmodule.promise : nextInfo)
    })()
  },
  render: args => <SwitchingSubmodule {...args} />,
  play: async ({ canvas, args }) => {
    await waitFor(() => expect(nativeCall).toHaveBeenCalledWith("submodule_info", { repo, file: "vendor/library" }))
    await userEvent.click(canvas.getByRole("button", { name: "Switch submodule" }))
    await canvas.findByText(i18n.t("submodule.from", { url: nextInfo.url }))
    oldSubmodule.resolve(info)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("submodule.open") }))
    await expect(args.onOpen).toHaveBeenCalledWith(nextInfo.fullPath)
    await expect(args.onOpen).not.toHaveBeenCalledWith(info.fullPath)
  }
}
