import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import i18n from "../src/lib/i18n"
import { ChangesFileList } from "../src/ui/changes/file-list"
import { DiffSelectionType } from "../src/upstream/models/diff"
import { file } from "./fixtures"
const files = ["first.ts", "second.ts", "third.ts"].map(path => ({ ...file, path }))
const meta = {
  title: "Changes/File list",
  component: ChangesFileList,
  args: {
    repo: "/preview/repository",
    files,
    selected: files[0].path,
    includeOf: (_path: string): DiffSelectionType => DiffSelectionType.All,
    onSelect: fn(),
    onIncludeChange: fn(),
    onDiscard: fn(),
    onBlame: fn()
  },
  render: args => {
    const [selected, select] = useState(args.selected)
    const [selectedPaths, selectPaths] = useState(args.selected ? [args.selected] : [])
    return (
      <ChangesFileList
        {...args}
        selected={selected}
        selectedPaths={selectedPaths}
        onSelectionChange={paths => {
          selectPaths(paths)
          const path = paths.at(-1) ?? null
          select(path)
          if (path) args.onSelect(path)
        }}
        onSelect={path => {
          select(path)
          args.onSelect(path)
        }}
      />
    )
  },
  decorators: [
    Story => (
      <div className="h-72">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof ChangesFileList>
export default meta
type Story = StoryObj<typeof meta>
export const KeyboardNavigation: Story = {
  play: async ({ canvas, args }) => {
    const first = (await canvas.findByText("first.ts")).closest<HTMLElement>('[role="listitem"]')!
    first.focus()
    await userEvent.keyboard("{ArrowDown}")
    await waitFor(() => expect(args.onSelect).toHaveBeenLastCalledWith("second.ts"))
    // Desktop on macOS uses Command+Down for the final row.
    await userEvent.keyboard("{Meta>}{ArrowDown}{/Meta}")
    await waitFor(() => expect(args.onSelect).toHaveBeenLastCalledWith("third.ts"))
    await userEvent.keyboard(" ")
    await expect(args.onIncludeChange).toHaveBeenCalledWith("third.ts", false)
  }
}
export const PartialInclusion: Story = { args: { includeOf: () => DiffSelectionType.Partial } }
export const TenThousandFiles: Story = {
  args: { files: Array.from({ length: 10000 }, (_, i) => ({ ...file, path: `file-${i}.ts` })), selected: "file-0.ts" },
  play: async ({ canvas, args }) => {
    const first = (await canvas.findByText("file-0.ts")).closest<HTMLElement>('[role="listitem"]')!
    first.focus()
    // Desktop on macOS uses Command+Down for the final row.
    await userEvent.keyboard("{Meta>}{ArrowDown}{/Meta}")
    await waitFor(() => expect(args.onSelect).toHaveBeenLastCalledWith("file-9999.ts"))
    await expect(await canvas.findByText("file-9999.ts")).toBeVisible()
    await expect(canvas.getAllByRole("listitem").length).toBeLessThan(100)
  }
}

export const MultipleSelection: Story = {
  args: { onDiscardMany: fn() },
  play: async ({ canvas, args }) => {
    const user = userEvent.setup()
    await user.click(await canvas.findByText("first.ts"))
    await user.keyboard("{Shift>}")
    await user.click(canvas.getByText("third.ts"))
    await user.keyboard("{/Shift}")
    await expect(
      canvas.getAllByRole("listitem").filter(row => row.getAttribute("aria-current") === "true")
    ).toHaveLength(3)
    await user.click(canvas.getAllByRole("checkbox")[1])
    await expect(args.onIncludeChange).toHaveBeenCalledTimes(1)
    await expect(args.onIncludeChange).toHaveBeenCalledWith("second.ts", false)
    args.onIncludeChange.mockClear()
    await user.pointer({ target: canvas.getByText("first.ts"), keys: "[MouseRight]" })
    await user.click(within(document.body).getByRole("menuitem", { name: i18n.t("changes.excludeSelected") }))
    for (const path of ["first.ts", "second.ts", "third.ts"]) {
      await expect(args.onIncludeChange).toHaveBeenCalledWith(path, false)
    }
    await waitFor(() =>
      expect(canvas.getAllByRole("listitem").filter(row => row.getAttribute("aria-current") === "true")).toHaveLength(3)
    )
    await user.keyboard("{Meta>}")
    await user.click(canvas.getByText("second.ts"))
    await user.keyboard("{/Meta}")
    await expect(
      canvas.getAllByRole("listitem").filter(row => row.getAttribute("aria-current") === "true")
    ).toHaveLength(2)
    await user.pointer({ target: canvas.getByText("first.ts"), keys: "[MouseRight]" })
    const menu = within(document.body).getByRole("menu")
    // Desktop order: discard first, then ignore, include / exclude, copy, reveal / open, then GitLens items
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map(item => item.textContent)
    await expect(labels[0]).toBe(i18n.t("changes.menu.discardSelected", { count: 2 }))
    await expect(labels).toContain(i18n.t("changes.menu.copyPaths"))
    await expect(labels.at(-1)).toBe(i18n.t("blame.open"))
    await user.click(within(menu).getByRole("menuitem", { name: i18n.t("changes.menu.discardSelected", { count: 2 }) }))
    await expect(args.onDiscardMany).toHaveBeenCalledWith(["first.ts", "third.ts"])
  }
}

export const NativeSelectAllAndKeyboardToggle: Story = {
  args: { includeOf: path => (path === "second.ts" ? DiffSelectionType.None : DiffSelectionType.All) },
  play: async ({ canvas, args }) => {
    const first = (await canvas.findByText("first.ts")).closest<HTMLElement>('[role="listitem"]')!
    first.focus()
    const event = new CustomEvent("select-all", { bubbles: true, cancelable: true })
    first.dispatchEvent(event)
    await expect(event.defaultPrevented).toBe(true)
    await waitFor(() =>
      expect(canvas.getAllByRole("listitem").filter(row => row.getAttribute("aria-current") === "true")).toHaveLength(3)
    )
    for (const key of ["{Enter}", " "]) {
      args.onIncludeChange.mockClear()
      await userEvent.keyboard(key)
      await expect(args.onIncludeChange).toHaveBeenCalledTimes(3)
      await expect(args.onIncludeChange).toHaveBeenCalledWith("first.ts", false)
      await expect(args.onIncludeChange).toHaveBeenCalledWith("second.ts", true)
      await expect(args.onIncludeChange).toHaveBeenCalledWith("third.ts", false)
    }
  }
}
