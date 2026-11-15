import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
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
  args: { repo, file: { ...file, path: "vendor/library" }, onOpen: fn() }
} satisfies Meta<typeof SubmoduleView>
export default meta
type Story = StoryObj<typeof meta>
export const ChangedAndDirty: Story = {}
export const Clean: Story = {
  beforeEach: withNativeFixtures({ submodule_info: () => ({ ...info, actual: info.recorded, dirty: 0 }) })
}
export const Loading: Story = { beforeEach: withNativeFixtures({ submodule_info: pending }) }
export const Failure: Story = {
  beforeEach: withNativeFixtures({ submodule_info: unavailable })
}
