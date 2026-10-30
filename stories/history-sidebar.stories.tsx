import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import { canDropCommits, takeCommitDrag } from "../src/lib/commit-drag"
import i18n from "../src/lib/i18n"
import type { SearchQuery } from "../src/models/history"
import { HistorySidebar } from "../src/ui/history/sidebar"
import { commit, repo, unavailable } from "./fixtures"
const commits = [commit, { ...commit, sha: "b".repeat(40), shortSha: "bbbbbbb", summary: "Initial commit" }]
/** 搜索框默认只开正则，和 GitLens 的 gitCommands.search 默认一致 */
const searchQuery = (query: string, overrides?: Partial<SearchQuery>): SearchQuery => ({
  query,
  matchAll: false,
  matchCase: false,
  matchRegex: true,
  matchWholeWord: false,
  ...overrides
})
const handlers = {
  branches: () => [{ name: "main" }, { name: "release" }],
  search_commits: () => [commit],
  compare_commits: () => ({ ahead: [commit], behind: [commits[1]] })
}
const meta = {
  title: "History/Sidebar",
  component: HistorySidebar,
  tags: ["desktop-window"],
  beforeEach: withNativeFixtures(handlers),
  afterEach: assertNativeFixtures,
  args: {
    commits,
    repo,
    rows: [],
    selected: null,
    currentBranch: "main",
    onSelect: fn(),
    onRevert: fn(),
    onCherryPick: fn(),
    onCherryPickMany: fn(),
    onSquashMany: fn(),
    onCreateTag: fn(),
    onResetTo: fn(),
    onSquashIntoParent: fn(),
    onMove: fn(),
    onReorder: fn(),
    onMerge: fn(),
    onCompared: fn()
  },
  decorators: [
    Story => (
      <div className="flex h-96 flex-col">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof HistorySidebar>
export default meta
type Story = StoryObj<typeof meta>
export const DragSelectedCommits: Story = {
  play: async ({ canvas, args }) => {
    const newest = await canvas.findByText(commit.summary)
    const oldest = canvas.getByText("Initial commit")
    await fireEvent.click(newest)
    await fireEvent.click(oldest, { metaKey: true })
    const row = newest.closest('[draggable="true"]')!
    const data = new DataTransfer()
    row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }))
    await expect(takeCommitDrag(data, repo)).toEqual([commits[1].sha, commit.sha])
    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: data }))
    row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }))
    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: data }))
    await expect(canDropCommits(data, repo)).toBe(false)
    await expect(args.onReorder).not.toHaveBeenCalled()
  }
}
export const SelectCommit: Story = {
  play: async ({ canvas, args }) => {
    await userEvent.click(await canvas.findByText(commit.summary))
    await expect(args.onSelect).toHaveBeenCalledWith(commit.sha)
  }
}
export const SearchAndClear: Story = {
  play: async ({ canvas }) => {
    const input = canvas.getByPlaceholderText(i18n.t("history.searchPlaceholder"))
    await userEvent.type(input, "Fix")
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("search_commits", {
        repo,
        query: searchQuery("Fix"),
        limit: 100,
        skip: 0
      })
    )
    await waitFor(() => expect(canvas.queryByText("Initial commit")).not.toBeInTheDocument())
    await userEvent.keyboard("{Escape}")
    await expect(await canvas.findByText("Initial commit")).toBeVisible()
  }
}
type Canvas = ReturnType<typeof within>

/** 匹配选项收在搜索框内的菜单里：打开、勾选、关上。 */
async function toggleMatchOption(canvas: Canvas, name: string) {
  await userEvent.click(canvas.getByRole("button", { name: i18n.t("history.matchOptions") }))
  await userEvent.click(await within(document.body).findByRole("menuitemcheckbox", { name }))
  await userEvent.keyboard("{Escape}")
}

/** 对比分支是图标菜单里的单选项；选「不对比」回到普通历史。 */
async function compareWith(canvas: Canvas, name: string) {
  await userEvent.click(canvas.getByRole("button", { name: new RegExp(`^${i18n.t("history.compareWith")}`) }))
  await userEvent.click(await within(document.body).findByRole("menuitemradio", { name }))
  await userEvent.keyboard("{Escape}")
}

export const ToggleMatchOptions: Story = {
  play: async ({ canvas }) => {
    await userEvent.type(canvas.getByPlaceholderText(i18n.t("history.searchPlaceholder")), "fix")
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("search_commits", {
        repo,
        query: searchQuery("fix"),
        limit: 100,
        skip: 0
      })
    )
    await toggleMatchOption(canvas, i18n.t("history.matchCase"))
    await toggleMatchOption(canvas, i18n.t("history.matchRegex"))
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("search_commits", {
        repo,
        query: searchQuery("fix", { matchCase: true, matchRegex: false }),
        limit: 100,
        skip: 0
      })
    )
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("history.searchHelp") }))
    await expect(await within(document.body).findByText(i18n.t("history.op_message"))).toBeVisible()
  }
}
export const CompareAndMerge: Story = {
  play: async ({ canvas, args }) => {
    await compareWith(canvas, "release")
    await userEvent.click(await canvas.findByRole("button", { name: i18n.t("history.mergeIn", { branch: "release" }) }))
    await expect(args.onMerge).toHaveBeenCalledWith("release")
    await expect(args.onCompared).toHaveBeenCalledWith({ ahead: [commit], behind: [commits[1]] })
    for (const entry of commits) {
      const title = await canvas.findByText(entry.summary)
      // compare rows are Desktop-style list rows (Item), not buttons
      const row = title.closest<HTMLElement>('[data-slot="item"]')!
      const bounds = row.getBoundingClientRect()
      for (const line of row.querySelectorAll("span")) {
        const textBounds = line.getBoundingClientRect()
        await expect(textBounds.top).toBeGreaterThanOrEqual(bounds.top)
        await expect(textBounds.bottom).toBeLessThanOrEqual(bounds.bottom)
        await expect(textBounds.height).toBeGreaterThan(0)
      }
    }
  }
}
export const Empty: Story = { args: { commits: [] } }
export const FailedSearch: Story = {
  beforeEach: withNativeFixtures({ ...handlers, search_commits: unavailable }),
  play: async ({ canvas }) => {
    await userEvent.type(canvas.getByPlaceholderText(i18n.t("history.searchPlaceholder")), "Fix")
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Preview service unavailable")
  }
}

export const ClearFailedSearch: Story = {
  beforeEach: withNativeFixtures({ ...handlers, search_commits: unavailable }),
  play: async ({ canvas }) => {
    await userEvent.type(canvas.getByPlaceholderText(i18n.t("history.searchPlaceholder")), "Fix")
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Preview service unavailable")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(canvas.queryByRole("alert")).not.toBeInTheDocument())
    await expect(await canvas.findByText("Initial commit")).toBeVisible()
  }
}

export const SwitchingComparison: Story = {
  beforeEach: withNativeFixtures({
    ...handlers,
    branches: () => [{ name: "main" }, { name: "release" }, { name: "next" }],
    compare_commits: args =>
      (args as { theirs: string }).theirs === "next" ? new Promise<never>(() => {}) : handlers.compare_commits()
  }),
  play: async ({ canvas, args }) => {
    await compareWith(canvas, "release")
    await expect(
      await canvas.findByRole("button", { name: i18n.t("history.mergeIn", { branch: "release" }) })
    ).toBeEnabled()
    await compareWith(canvas, "next")
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("compare_commits", { repo, ours: "main", theirs: "next", limit: 200 })
    )
    await expect(
      canvas.queryByRole("button", { name: i18n.t("history.mergeIn", { branch: "next" }) })
    ).not.toBeInTheDocument()
    await expect(args.onCompared).toHaveBeenLastCalledWith(null)
    await expect(args.onMerge).not.toHaveBeenCalled()
  }
}

export const ClearFailedComparison: Story = {
  beforeEach: withNativeFixtures({ ...handlers, compare_commits: unavailable }),
  play: async ({ canvas }) => {
    await compareWith(canvas, "release")
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Preview service unavailable")
    await compareWith(canvas, i18n.t("history.noCompare"))
    await waitFor(() => expect(canvas.queryByRole("alert")).not.toBeInTheDocument())
    await expect(await canvas.findByText("Initial commit")).toBeVisible()
  }
}

const fileHistoryPath = "packages/gitcub/features/history/very-long-name-for-a-commit-file-component.tsx"
/** 文件历史模式：工具栏只有路径标签和关闭按钮；还有下一页时滚到底就取，取的时候页脚显示加载中 */
export const FileHistory: Story = {
  args: {
    fileHistory: { path: fileHistoryPath, commits, hasMore: true, loadingMore: true, onLoadMore: fn() },
    onCloseFileHistory: fn()
  },
  // 左栏的典型宽度：路径必须截断，关闭按钮仍在同一行
  decorators: [
    Story => (
      <div className="w-80">
        <Story />
      </div>
    )
  ],
  play: async ({ canvas }) => {
    const chip = await canvas.findByTitle(i18n.t("history.fileHistory", { path: fileHistoryPath }))
    await expect(chip).toBeVisible()
    const text = chip.querySelector("span")!
    await expect(text.scrollWidth).toBeGreaterThan(text.clientWidth)
    await expect(chip.getBoundingClientRect().right).toBeLessThanOrEqual(
      canvas.getByRole("button", { name: i18n.t("history.closeFileHistory") }).getBoundingClientRect().left
    )
    await expect(canvas.queryByPlaceholderText(i18n.t("history.searchPlaceholder"))).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: new RegExp(`^${i18n.t("history.compareWith")}`) })
    ).not.toBeInTheDocument()
    await expect(canvas.getByRole("status")).toHaveTextContent(i18n.t("history.loadingMore"))
    await expect(canvas.getByText(commit.summary).closest("[draggable]")).toHaveAttribute("draggable", "false")
  }
}
export const CloseFileHistory: Story = {
  args: { fileHistory: { path: "src/main.tsx", commits: [commit], hasMore: false }, onCloseFileHistory: fn() },
  play: async ({ canvas, args }) => {
    await expect(await canvas.findByRole("status")).toHaveTextContent(i18n.t("history.end"))
    await expect(canvas.queryByText("Initial commit")).not.toBeInTheDocument()
    await userEvent.click(await canvas.findByText(commit.summary))
    await expect(args.onSelect).toHaveBeenCalledWith(commit.sha)
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("history.closeFileHistory") }))
    await expect(args.onCloseFileHistory).toHaveBeenCalledTimes(1)
  }
}
export const FailedFileHistory: Story = {
  args: {
    fileHistory: { path: "src/main.tsx", commits: [], hasMore: false, error: "Preview service unavailable" },
    onCloseFileHistory: fn()
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Preview service unavailable")
    await expect(canvas.getByText(i18n.t("history.fileHistoryEmpty"))).toBeVisible()
  }
}

export const PendingSearchCannotReorder: Story = {
  beforeEach: withNativeFixtures({ ...handlers, search_commits: () => new Promise<never>(() => {}) }),
  play: async ({ canvas }) => {
    const input = canvas.getByPlaceholderText(i18n.t("history.searchPlaceholder"))
    await userEvent.type(input, "Fix")
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("search_commits", {
        repo,
        query: searchQuery("Fix"),
        limit: 100,
        skip: 0
      })
    )
    await expect(canvas.getByText(commit.summary).closest("[draggable]")).toHaveAttribute("draggable", "false")
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(canvas.getByText(commit.summary).closest("[draggable]")).toHaveAttribute("draggable", "true")
    )
  }
}

/** 提交图从全部分支、标签和贮藏遍历：贮藏行带虚线标记、只给复制 SHA；别的分支上的提交不按 HEAD 历史改写，
 *  压缩、挪动按 HEAD 历史里的下标回调（贮藏行和 feature 上的提交不占下标） */
const stashSha = "c".repeat(40)
const featureSha = "d".repeat(40)
const allRefs = [
  commit,
  { ...commit, sha: stashSha, shortSha: "ccccccc", summary: "On main: wip" },
  { ...commit, sha: featureSha, shortSha: "ddddddd", summary: "Feature work" },
  commits[1]
]
const base = commits[1].sha
export const StashAndOtherBranchRows: Story = {
  args: {
    commits: allRefs,
    rows: [
      { commit: allRefs[0], lane: 0, lanes: [base], refs: ["main"], head: "main", onHead: true, stash: null },
      { commit: allRefs[1], lane: 1, lanes: [base, base], refs: [], onHead: false, stash: 0 },
      { commit: allRefs[2], lane: 2, lanes: [base, base, base], refs: ["feature"], onHead: false, stash: null },
      { commit: allRefs[3], lane: 0, lanes: [], refs: [], onHead: true, stash: null }
    ]
  },
  play: async ({ canvas, args }) => {
    const badge = await canvas.findByText(i18n.t("history.stashBadge", { index: 0 }))
    await expect(badge).toHaveAttribute(
      "title",
      i18n.t("history.stashRow", { ref: "stash@{0}", base: base.slice(0, 7) })
    )
    await expect(canvas.getByText("On main: wip").closest("[draggable]")).toHaveAttribute("draggable", "false")
    const body = within(document.body)

    fireEvent.contextMenu(canvas.getByText("On main: wip"))
    await expect(await body.findByRole("menuitem", { name: i18n.t("history.copySha") })).toBeVisible()
    await expect(body.queryByRole("menuitem", { name: i18n.t("history.revert") })).not.toBeInTheDocument()
    await expect(body.queryByRole("menuitem", { name: i18n.t("history.cherryPick") })).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")

    fireEvent.contextMenu(canvas.getByText("Feature work"))
    await expect(await body.findByRole("menuitem", { name: i18n.t("history.cherryPick") })).toBeVisible()
    await expect(body.queryByRole("menuitem", { name: i18n.t("history.squashIntoParent") })).not.toBeInTheDocument()
    await expect(body.queryByRole("menuitem", { name: i18n.t("history.resetTo") })).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")

    fireEvent.contextMenu(canvas.getByText(commit.summary))
    await userEvent.click(await body.findByRole("menuitem", { name: i18n.t("history.squashIntoParent") }))
    await expect(args.onSquashIntoParent).toHaveBeenCalledWith(0)
  }
}
