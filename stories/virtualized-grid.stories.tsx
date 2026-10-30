import type { Meta, StoryObj } from "@storybook/react-vite"
import { useRef, useState } from "react"
import { expect, fn, userEvent, waitFor } from "storybook/test"

import { Button } from "../src/ui/base/button"
import { Grid, type GridImperativeAPI } from "../src/ui/desktop/list/virtualized-grid"

// Migrated from tests/conformance/virtualized-grid.test.ts; preserve every offset/ref assertion.
function ControlledGrid({ onRefChange }: { onRefChange: (value: GridImperativeAPI | null) => void }) {
  const ref = useRef<GridImperativeAPI | null>(null)
  const [offset, setOffset] = useState<number | undefined>(200)
  const [mounted, setMounted] = useState(true)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 overflow-x-auto">
        <Button onClick={() => setOffset(600)}>Set offset</Button>
        <Button onClick={() => setOffset(undefined)}>Release control</Button>
        <Button onClick={() => ref.current?.scrollToPosition({ scrollTop: 400 })}>Scroll imperatively</Button>
        <Button onClick={() => ref.current?.recomputeGridSize()}>Recompute</Button>
        <Button onClick={() => setMounted(false)}>Unmount</Button>
      </div>
      {mounted && (
        <Grid
          ref={value => {
            ref.current = value
            onRefChange(value)
          }}
          scrollTop={offset}
          width={300}
          height={100}
          columnCount={1}
          columnWidth={300}
          rowCount={100}
          rowHeight={20}
          cellRenderer={({ key, style, rowIndex }) => (
            <div key={key} style={style}>
              Row {rowIndex}
            </div>
          )}
        />
      )}
    </div>
  )
}
const meta = {
  title: "Lists/Controlled virtual grid",
  component: ControlledGrid,
  args: { onRefChange: fn() }
} satisfies Meta<typeof ControlledGrid>
export default meta
type Story = StoryObj<typeof meta>
export const ControlledOffsetsAndImperativeRef: Story = {
  play: async ({ canvas, canvasElement, args }) => {
    const viewport = canvasElement.querySelector<HTMLElement>(".ReactVirtualized__Grid")!
    await expect(viewport).not.toBeNull()
    await waitFor(() => expect(viewport.scrollTop).toBe(200))
    await userEvent.click(canvas.getByRole("button", { name: "Set offset" }))
    await waitFor(() => expect(viewport.scrollTop).toBe(600))
    await userEvent.click(canvas.getByRole("button", { name: "Release control" }))
    await userEvent.click(canvas.getByRole("button", { name: "Scroll imperatively" }))
    await waitFor(() => expect(viewport.scrollTop).toBe(400))
    await userEvent.click(canvas.getByRole("button", { name: "Recompute" }))
    await expect(viewport.scrollTop).toBe(400)
    await userEvent.click(canvas.getByRole("button", { name: "Unmount" }))
    await expect(args.onRefChange).toHaveBeenLastCalledWith(null)
    await expect(viewport).not.toBeInTheDocument()
  }
}
