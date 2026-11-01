import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ComponentProps, useState } from "react"
import { expect, userEvent, waitFor } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
import type { ImageDiff } from "../src/models/app-state"
import { Button } from "@/components/ui/button"
import { ImagePane } from "../src/ui/diff/diff"
import { repo } from "./fixtures"

const picture = (color: string) => ({
  mediaType: "image/svg+xml",
  bytes: 100,
  data: btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${color}"/></svg>`
  )
})
const nextData = { previous: null, current: picture("blue") }
let oldImage: ReturnType<typeof Promise.withResolvers<ImageDiff>>
function SwitchingImage(args: ComponentProps<typeof ImagePane>) {
  const [file, setFile] = useState(args.file)
  return (
    <>
      <Button onClick={() => setFile("new.svg")}>Switch image</Button>
      <ImagePane {...args} file={file} />
    </>
  )
}
const meta = {
  title: "Diff/Image loading",
  component: ImagePane,
  tags: ["desktop-window"],
  args: { repo, file: "old.svg", sha: null },
  beforeEach: () => {
    oldImage = Promise.withResolvers<ImageDiff>()
    return withNativeFixtures({
      image_diff: args => ((args as { file: string }).file === "old.svg" ? oldImage.promise : nextData)
    })()
  },
  afterEach: assertNativeFixtures,
  render: args => <SwitchingImage {...args} />
} satisfies Meta<typeof ImagePane>
export default meta
type Story = StoryObj<typeof meta>
export const IgnoreLateImage: Story = {
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("image_diff", expect.objectContaining({ repo, file: "old.svg" }))
    )
    await userEvent.click(canvas.getByRole("button", { name: "Switch image" }))
    const image = await canvas.findByRole("img")
    await expect(image).toHaveAttribute("src", `data:image/svg+xml;base64,${nextData.current.data}`)
    oldImage.resolve({ previous: null, current: picture("red") })
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await expect(canvas.getByRole("img")).toHaveAttribute("src", `data:image/svg+xml;base64,${nextData.current.data}`)
  }
}
export const IgnoreLateError: Story = {
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("image_diff", expect.objectContaining({ file: "old.svg" }))
    )
    await userEvent.click(canvas.getByRole("button", { name: "Switch image" }))
    await canvas.findByRole("img")
    oldImage.reject(new Error("Old image failed"))
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await expect(canvas.getByRole("img")).toBeVisible()
    await expect(canvas.queryByText(i18n.t("diff.binary"))).not.toBeInTheDocument()
  }
}
