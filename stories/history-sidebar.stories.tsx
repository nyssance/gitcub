import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
import { HistorySidebar } from "../src/ui/history/sidebar"
import { commit, repo, unavailable } from "./fixtures"
const commits = [commit, { ...commit, sha: "b".repeat(40), shortSha: "bbbbbbb", summary: "Initial commit" }]
const handlers = {
  branches: () => [{ name: "main" }, { name: "release" }],
  search_commits: () => [commit],
  compare_commits: () => ({ ahead: [commit], behind: [commits[1]] })
}
const meta = {
  title: "History/Sidebar",
  component: HistorySidebar,
  beforeEach: withNativeFixtures(handlers),
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
export const SelectCommit: Story = {}

export const CompareAndMerge: Story = {}
export const Empty: Story = { args: { commits: [] } }
export const FailedSearch: Story = {
  beforeEach: withNativeFixtures({ ...handlers, search_commits: unavailable })
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
  ]
}
export const FailedFileHistory: Story = {
  args: {
    fileHistory: { path: "src/main.tsx", commits: [], hasMore: false, error: "Preview service unavailable" },
    onCloseFileHistory: fn()
  }
}

/** 提交图从全部分支、标签和贮藏遍历：贮藏行带虚线标记、只给复制 SHA；别的分支上的提交不按 HEAD 历史改写，
 *  重排按 HEAD 历史里的插入位置回调（贮藏行和 feature 上的提交不占下标） */
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
  }
}
