import type { Meta, StoryObj } from "@storybook/react-vite"

import { CommitGraph } from "../src/ui/history/graph"

const meta = {
  title: "History/Commit graph",
  component: CommitGraph,
  args: { lanesBefore: ["head"], lane: 0, lanesAfter: ["parent"], height: 48 }
} satisfies Meta<typeof CommitGraph>
export default meta
type Story = StoryObj<typeof meta>
export const Linear: Story = {}
export const Merge: Story = {
  args: {
    lanesAfter: ["parent", "feature"],
    parents: ["parent", "feature"],
    streamsBefore: [0],
    streamsAfter: [0, 1],
    stream: 0
  }
}
export const ParallelLanes: Story = {
  args: { lanesBefore: ["main", "feature", "release"], lane: 1, lanesAfter: ["main", "parent", "release"] }
}
export const Root: Story = { args: { lanesAfter: [] } }
export const Head: Story = { args: { head: true } }

/** 一行的夹具：和 Rust `GraphRow` 同形，只留画图要用的字段 */
interface Row {
  sha: string
  parents: string[]
  lane: number
  lanes: string[]
  stream: number
  streams: number[]
}

/** 由 Rust `graph::lanes` 对 `busy_history(12)` 算出的 18 行（graph.rs 的测试夹具）：
 *  主线每 4 个提交合并一条三个提交的分支，两条分支并行；m006 处第一条分支汇入，
 *  第二条分支从第 3 列挪到第 2 列但颜色不变。 */
const FIXTURE: Row[] = [
  { sha: "m000", parents: ["m001", "f000-0"], lane: 0, lanes: ["m001", "f000-0"], stream: 0, streams: [0, 1] },
  { sha: "f000-0", parents: ["f000-1"], lane: 1, lanes: ["m001", "f000-1"], stream: 1, streams: [0, 1] },
  { sha: "f000-1", parents: ["f000-2"], lane: 1, lanes: ["m001", "f000-2"], stream: 1, streams: [0, 1] },
  { sha: "f000-2", parents: ["m006"], lane: 1, lanes: ["m001", "m006"], stream: 1, streams: [0, 1] },
  { sha: "m001", parents: ["m002"], lane: 0, lanes: ["m002", "m006"], stream: 0, streams: [0, 1] },
  { sha: "m002", parents: ["m003"], lane: 0, lanes: ["m003", "m006"], stream: 0, streams: [0, 1] },
  { sha: "m003", parents: ["m004"], lane: 0, lanes: ["m004", "m006"], stream: 0, streams: [0, 1] },
  {
    sha: "m004",
    parents: ["m005", "f004-0"],
    lane: 0,
    lanes: ["m005", "m006", "f004-0"],
    stream: 0,
    streams: [0, 1, 2]
  },
  { sha: "f004-0", parents: ["f004-1"], lane: 2, lanes: ["m005", "m006", "f004-1"], stream: 2, streams: [0, 1, 2] },
  { sha: "f004-1", parents: ["f004-2"], lane: 2, lanes: ["m005", "m006", "f004-2"], stream: 2, streams: [0, 1, 2] },
  { sha: "f004-2", parents: ["m010"], lane: 2, lanes: ["m005", "m006", "m010"], stream: 2, streams: [0, 1, 2] },
  { sha: "m005", parents: ["m006"], lane: 0, lanes: ["m006", "m006", "m010"], stream: 0, streams: [0, 1, 2] },
  { sha: "m006", parents: ["m007"], lane: 0, lanes: ["m007", "m010"], stream: 0, streams: [0, 2] },
  { sha: "m007", parents: ["m008"], lane: 0, lanes: ["m008", "m010"], stream: 0, streams: [0, 2] },
  { sha: "m008", parents: ["m009"], lane: 0, lanes: ["m009", "m010"], stream: 0, streams: [0, 2] },
  { sha: "m009", parents: ["m010"], lane: 0, lanes: ["m010", "m010"], stream: 0, streams: [0, 2] },
  { sha: "m010", parents: ["m011"], lane: 0, lanes: ["m011"], stream: 0, streams: [0] },
  { sha: "m011", parents: [], lane: 0, lanes: [], stream: 0, streams: [] }
]

/** 把若干行叠起来画成一列。`from`/`to` 切出一页，上一行仍取自完整列表——和真实翻页一样接着上一页的末尾。 */
function Column({ rows, from = 0, to = rows.length }: { rows: Row[]; from?: number; to?: number }) {
  return (
    <div className="flex flex-col">
      {rows.slice(from, to).map((row, i) => {
        const previous = rows[from + i - 1]
        return (
          <div key={row.sha} className="flex items-center gap-2 font-mono text-xs">
            <CommitGraph
              lanesBefore={previous?.lanes ?? []}
              streamsBefore={previous?.streams ?? []}
              lane={row.lane}
              lanesAfter={row.lanes}
              streamsAfter={row.streams}
              stream={row.stream}
              parents={row.parents}
              head={from + i === 0}
              height={28}
            />
            <span>{row.sha}</span>
          </div>
        )
      })}
    </div>
  )
}

/** 合并密集的历史：分支各自一种颜色，汇入后右边的分支左移也不换色 */
export const MergeHeavy: Story = { render: () => <Column rows={FIXTURE} /> }

/** 分两页画同一段历史：第二页从第一页末尾的泳道接着画，边界处连线和颜色都不断 */
export const Paged: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <Column rows={FIXTURE} to={7} />
      <div className="text-muted-foreground border-t border-dashed text-[10px]">第二页</div>
      <Column rows={FIXTURE} from={7} />
    </div>
  )
}
