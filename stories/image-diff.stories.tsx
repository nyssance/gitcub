import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, waitFor } from "storybook/test"

import i18n from "../src/lib/i18n"
import { Button } from "../src/ui/base/button"
import { ImageDiffView } from "../src/ui/diff/image"

const picture = (color: string) => ({
  mediaType: "image/svg+xml",
  bytes: 140,
  data: btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="${color}"/><circle cx="80" cy="60" r="32" fill="white"/></svg>`
  )
})
const previous = picture("#155e75")
const current = { ...picture("#1d4ed8"), bytes: 160 }
const meta = {
  title: "Diff/Image comparison",
  component: ImageDiffView,
  tags: ["desktop-window"],
  args: { data: { previous, current } },
  decorators: [
    Story => (
      <div className="flex h-96 flex-col">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof ImageDiffView>
export default meta
type Story = StoryObj<typeof meta>
export const SideBySide: Story = {}
export const Added: Story = { args: { data: { previous: null, current } } }
export const Deleted: Story = { args: { data: { previous, current: null } } }
export const TooLarge: Story = { args: { data: { previous: null, current: null } } }
export const ComparisonModes: Story = {
  play: async ({ canvas }) => {
    for (const mode of ["swipe", "onion", "difference", "two-up"]) {
      await userEvent.click(canvas.getByRole("button", { name: i18n.t(`diff.image_${mode}`) }))
      await expect(canvas.getByRole("img", { name: i18n.t("diff.imageBefore") })).toBeInTheDocument()
      await expect(canvas.getByRole("img", { name: i18n.t("diff.imageAfter") })).toBeInTheDocument()
      if (mode === "swipe" || mode === "onion") {
        const slider = canvas.getByRole("slider")
        await expect(slider).toHaveAttribute("aria-valuenow", mode === "swipe" ? "0" : "1")
        slider.focus()
        await userEvent.keyboard("{ArrowRight}")
        await expect(slider).toHaveAttribute("aria-valuenow", mode === "swipe" ? "0.1" : "1.1")
        await userEvent.keyboard("{ArrowLeft}")
      } else await expect(canvas.queryByRole("slider")).not.toBeInTheDocument()
    }
  }
}

// Desktop bebc062 image-diffs/{swipe,onion-skin}.tsx: independent initial values,
// 0.1 percentage-point steps, and reset on mode remount. Project regression, not an upstream test port.
export const SliderEndpointsAndModeReset: Story = {
  play: async ({ canvas }) => {
    const select = async (mode: string) => {
      const button = canvas.getByRole("button", { name: i18n.t(`diff.image_${mode}`) })
      await userEvent.click(button)
      await expect(button).toHaveAttribute("aria-pressed", "true")
    }
    await select("swipe")
    let slider = canvas.getByRole("slider")
    await expect(slider).toHaveAttribute("aria-valuenow", "0")
    slider.focus()
    await userEvent.keyboard("{End}")
    await expect(slider).toHaveAttribute("aria-valuenow", "100")
    await expect(canvas.getByRole("img", { name: i18n.t("diff.imageBefore") }).parentElement).toHaveStyle({
      clipPath: "inset(0 0% 0 0)"
    })
    await userEvent.keyboard("{Home}")
    await expect(slider).toHaveAttribute("aria-valuenow", "0")
    await expect(canvas.getByRole("img", { name: i18n.t("diff.imageBefore") }).parentElement).toHaveStyle({
      clipPath: "inset(0 100% 0 0)"
    })
    await select("onion")
    slider = canvas.getByRole("slider")
    await expect(slider).toHaveAttribute("aria-valuenow", "1")
    const after = canvas.getByRole("img", { name: i18n.t("diff.imageAfter") }).parentElement!
    await expect(after).toHaveStyle({ opacity: "0.01" })
    slider.focus()
    await userEvent.keyboard("{End}")
    await expect(after).toHaveStyle({ opacity: "1" })
    await userEvent.keyboard("{Home}")
    await expect(after).toHaveStyle({ opacity: "0" })
    await select("two-up")
    await select("onion")
    await expect(canvas.getByRole("slider")).toHaveAttribute("aria-valuenow", "1")
    await select("swipe")
    await expect(canvas.getByRole("slider")).toHaveAttribute("aria-valuenow", "0")
    await select("swipe")
    await expect(canvas.getByRole("slider")).toHaveAttribute("aria-valuenow", "0")
  }
}

const sizedPicture = (width: number, height: number) => ({
  mediaType: "image/svg+xml",
  bytes: 200,
  data: btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="navy"/></svg>`
  )
})
export const DifferentDimensionsAndResize: Story = {
  args: { data: { previous: sizedPicture(1200, 300), current: sizedPicture(300, 1200) } },
  play: async ({ canvas, canvasElement }) => {
    for (const width of [320, 700]) {
      canvasElement.style.width = `${width}px`
      for (const mode of ["two-up", "swipe", "onion", "difference"]) {
        await userEvent.click(canvas.getByRole("button", { name: i18n.t(`diff.image_${mode}`) }))
        await waitFor(() => {
          const before = canvas.getByRole("img", { name: i18n.t("diff.imageBefore") }) as HTMLImageElement
          const after = canvas.getByRole("img", { name: i18n.t("diff.imageAfter") }) as HTMLImageElement
          for (const image of [before, after]) {
            const bounds = image.getBoundingClientRect()
            expect(bounds.width).toBeGreaterThan(0)
            expect(bounds.height).toBeGreaterThan(0)
            expect(bounds.width / bounds.height).toBeCloseTo(image.naturalWidth / image.naturalHeight, 1)
            expect(bounds.width).toBeLessThanOrEqual(image.naturalWidth)
            expect(bounds.height).toBeLessThanOrEqual(image.naturalHeight)
            expect(bounds.right).toBeLessThanOrEqual(canvasElement.getBoundingClientRect().right + 1)
            if (mode !== "two-up") {
              const frame = image.parentElement!.getBoundingClientRect()
              expect(bounds.width).toBeLessThanOrEqual(frame.width + 1)
              expect(bounds.height).toBeLessThanOrEqual(frame.height + 1)
            }
          }
        })
      }
    }
  }
}
const broken = { mediaType: "image/png", bytes: 3, data: "AAAA" }
export const LoadFailure: Story = {
  args: { data: { previous: null, current: broken } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("alert")).toHaveTextContent(i18n.t("diff.imageLoadFailed"))
    await expect(canvas.queryByRole("img")).not.toBeInTheDocument()
  }
}
function RecoverImage() {
  const [current, setCurrent] = useState(broken)
  return (
    <>
      <Button onClick={() => setCurrent(sizedPicture(80, 60))}>Next image</Button>
      <ImageDiffView data={{ previous: null, current }} />
    </>
  )
}
export const RecoverAfterLoadFailure: Story = {
  render: () => <RecoverImage />,
  play: async ({ canvas }) => {
    await canvas.findByRole("alert")
    await userEvent.click(canvas.getByRole("button", { name: "Next image" }))
    await waitFor(() => expect((canvas.getByRole("img") as HTMLImageElement).naturalWidth).toBe(80))
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  }
}
