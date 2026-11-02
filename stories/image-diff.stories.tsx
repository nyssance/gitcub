import type { Meta, StoryObj } from "@storybook/react-vite"

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
export const ComparisonModes: Story = {}

const sizedPicture = (width: number, height: number) => ({
  mediaType: "image/svg+xml",
  bytes: 200,
  data: btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="navy"/></svg>`
  )
})
export const DifferentDimensionsAndResize: Story = {
  args: { data: { previous: sizedPicture(1200, 300), current: sizedPicture(300, 1200) } }
}
const broken = { mediaType: "image/png", bytes: 3, data: "AAAA" }
export const LoadFailure: Story = {
  args: { data: { previous: null, current: broken } }
}
