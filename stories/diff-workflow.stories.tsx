import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import { initialSelection } from "../src/lib/diff"
import i18n from "../src/lib/i18n"
import { Button } from "../src/ui/base/button"
import { DiffView } from "../src/ui/diff/diff"
import { DiffParser } from "../src/upstream/lib/diff-parser"

const patch =
  "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -4,5 +4,5 @@\n context4\n-old5\n+new5\n context6\n-old7\n+new7\n context8\n"
const diff = new DiffParser().parse(patch)
const contents = "context1\ncontext2\ncontext3\ncontext4\nnew5\ncontext6\nnew7\ncontext8\ncontext9\n"
const fixture =
  (extra: Parameters<typeof withNativeFixtures>[0] = {}) =>
  () => {
    localStorage.setItem("diff-layout", "unified")
    return withNativeFixtures({
      "plugin:event|listen": () => 1,
      "plugin:event|unlisten": () => {},
      file_contents: () => ({ modified: contents }),
      repo_status: () => ({ changes: [{ path: "a.txt", kind: "unstaged", change: "modified" }] }),
      working_directory_diff: () => ({ text: patch, lineEndings: null }),
      ...extra
    })()
  }
const meta = {
  title: "Diff/Working file",
  component: DiffView,
  tags: ["desktop-window"],
  beforeEach: fixture(),
  args: {
    repo: "/fixture",
    file: "a.txt",
    diff,
    selection: initialSelection(diff),
    error: null,
    onDiscardLines: fn(),
    onSelectionChange: fn()
  },
  render: args => {
    const [selection, setSelection] = useState(args.selection)
    return (
      <DiffView
        {...args}
        selection={selection}
        onSelectionChange={value => {
          setSelection(value)
          args.onSelectionChange?.(value)
        }}
      />
    )
  },
  decorators: [
    Story => (
      <div className="flex h-96 flex-col">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof DiffView>
export default meta
type Story = StoryObj<typeof meta>
const openMenu = async (element: Element) => userEvent.pointer({ target: element, keys: "[MouseRight]" })
const menu = () => within(document.body)
export const DiscardOnlyContiguousBlock: Story = {
  play: async ({ canvas, args }) => {
    const line = await canvas.findByRole("checkbox", { name: "Line 5 added" })
    await openMenu(line.closest(".line-number")!.querySelector("label")!)
    await userEvent.click(await menu().findByRole("menuitem", { name: i18n.t("diff.discardHunk") }))
    await expect(args.onDiscardLines).toHaveBeenCalledWith(diff, [2, 3])
  }
}
export const ClearContextOnBlankArea: Story = {
  play: async ({ canvas, canvasElement, args }) => {
    const line = await canvas.findByRole("checkbox", { name: "Line 5 added" })
    await openMenu(line.closest(".line-number")!.querySelector("label")!)
    await userEvent.keyboard("{Escape}")
    await openMenu(canvasElement.querySelector(".unified-diff")!)
    await expect(await menu().findByRole("menuitem", { name: i18n.t("diff.discardLine") })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    await expect(args.onDiscardLines).not.toHaveBeenCalled()
  }
}
export const ExpandSelectDiscardAndCollapse: Story = {
  play: async ({ canvas, canvasElement, args }) => {
    await openMenu(await canvas.findByRole("button", { name: "Expand Up" }))
    await userEvent.click(await menu().findByRole("menuitem", { name: i18n.t("diff.expandAll") }))
    await expect(await canvas.findByText("context1")).toBeVisible()
    const line = canvas.getByRole("checkbox", { name: "Line 7 added" })
    line.focus()
    await userEvent.keyboard(" ")
    await waitFor(() => expect(args.onSelectionChange).toHaveBeenCalled())
    const next = args.onSelectionChange!.mock.calls.at(-1)![0]
    await expect(next.isSelected(6)).toBe(false)
    await expect(next.isSelected(3)).toBe(true)
    await openMenu(line.closest(".line-number")!.querySelector("label")!)
    await userEvent.click(await menu().findByRole("menuitem", { name: i18n.t("diff.discardHunk") }))
    await expect(args.onDiscardLines).toHaveBeenCalledWith(diff, [5, 6])
    await openMenu(canvasElement.querySelector(".unified-diff")!)
    await userEvent.click(await menu().findByRole("menuitem", { name: i18n.t("diff.collapse") }))
    await waitFor(() => expect(canvas.queryByText("context1")).not.toBeInTheDocument())
    await expect(canvas.getByRole("checkbox", { name: "Line 7 added" })).not.toBeChecked()
  }
}
export const FilteredDiffCannotDiscard: Story = {
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("diff.hideWhitespace") }))
    const line = await canvas.findByRole("checkbox", { name: "Line 5 added" })
    await openMenu(line.closest(".line-number")!.querySelector("label")!)
    await expect(await menu().findByRole("menuitem", { name: i18n.t("diff.discardLine") })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    await expect(args.onDiscardLines).not.toHaveBeenCalled()
  }
}
export const ExpansionFailureCanRetry: Story = {
  beforeEach: () => {
    let calls = 0
    return fixture({
      file_contents: () => {
        if (calls++ === 0) throw new Error("Read failed")
        return { modified: contents }
      }
    })()
  },
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Expand Up" }))
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Read failed")
    await userEvent.click(canvas.getByRole("button", { name: "Expand Up" }))
    await expect(await canvas.findByText("context1")).toBeVisible()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await expect(canvas.getByRole("table").contains(document.activeElement)).toBe(true)
    await expect(nativeCall.mock.calls.filter(([name]) => name === "file_contents")).toHaveLength(2)
  }
}

const pending = Promise.withResolvers<{ modified: string }>()
export const IgnoreExpansionAfterFileSwitch: Story = {
  beforeEach: fixture({ file_contents: () => pending.promise }),
  render: args => {
    const [file, setFile] = useState("a.txt")
    return (
      <>
        <Button onClick={() => setFile("b.txt")}>Switch file</Button>
        <DiffView {...args} file={file} />
      </>
    )
  },
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Expand Up" }))
    await userEvent.click(canvas.getByRole("button", { name: "Switch file" }))
    pending.resolve({ modified: contents })
    await new Promise(requestAnimationFrame)
    await expect(canvas.getByText("b.txt")).toBeVisible()
    await expect(canvas.queryByText("context1")).not.toBeInTheDocument()
  }
}

export const SearchEveryOccurrence: Story = {
  args: {
    diff: new DiffParser().parse(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+word word\n"
    ),
    readOnly: true
  },
  play: async ({ canvas, canvasElement }) => {
    const search = canvas.getByRole("textbox", { name: i18n.t("diff.search") })
    await userEvent.type(search, "word")
    await expect(canvas.getByRole("status")).toHaveTextContent("1/2")
    const first = canvasElement.querySelector(".cm-search-result-current")
    await expect(first).toHaveTextContent("word")
    await userEvent.keyboard("{Enter}")
    await expect(canvas.getByRole("status")).toHaveTextContent("2/2")
    await expect(canvasElement.querySelector(".cm-search-result-current")).not.toBe(first)
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}")
    await expect(canvas.getByRole("status")).toHaveTextContent("1/2")
    await userEvent.clear(search)
    await userEvent.type(search, "absent")
    await expect(canvas.getByRole("status")).toHaveTextContent("0/0")
  }
}
export const WhitespaceSelectionGuard: Story = {
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("diff.hideWhitespace") }))
    const line = await canvas.findByRole("checkbox", { name: "Line 5 added" })
    await userEvent.click(line.closest(".line-number")!.querySelector("label")!)
    const dialog = await menu().findByRole("dialog")
    await expect(dialog).toHaveTextContent(i18n.t("diff.whitespaceBody"))
    await expect(args.onSelectionChange).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: i18n.t("diff.showWhitespace") }))
    await expect(canvas.getByRole("button", { name: i18n.t("diff.hideWhitespace") })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  }
}
export const SelectAllCopiesUnmountedRows: Story = {
  args: {
    diff: new DiffParser().parse(
      `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,1000 @@\n${Array.from(
        { length: 1000 },
        (_, i) => `+line${i}\n`
      ).join("")}`
    ),
    readOnly: true
  },
  play: async ({ canvasElement }) => {
    const viewport = canvasElement.querySelector<HTMLElement>(".unified-diff")!
    await openMenu(viewport)
    await userEvent.click(await menu().findByRole("menuitem", { name: i18n.t("diff.selectAll") }))
    await waitFor(() => expect(document.getSelection()?.rangeCount).toBe(1))
    const clipboard = new DataTransfer()
    viewport.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: clipboard }))
    await expect(clipboard.getData("text/plain")).toContain("line999")
    await expect(canvasElement.querySelectorAll('[role="row"]').length).toBeLessThan(100)
  }
}

export const NativeSelectAllCopiesDiff: Story = {
  play: async ({ canvasElement }) => {
    const viewport = canvasElement.querySelector<HTMLElement>(".unified-diff")!
    viewport.focus()
    const event = new CustomEvent("select-all", { bubbles: true, cancelable: true })
    viewport.dispatchEvent(event)
    await expect(event.defaultPrevented).toBe(true)
    const clipboard = new DataTransfer()
    viewport.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: clipboard }))
    await expect(clipboard.getData("text/plain")).toContain("old5")
    await expect(clipboard.getData("text/plain")).toContain("new7")
  }
}
