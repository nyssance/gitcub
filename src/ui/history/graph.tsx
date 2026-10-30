/** 提交图的一列。
 *
 * 数据（泳道分配、色流）在 Rust 侧算好，这里只负责把相邻两行的泳道状态画成线：
 *   - 上一行某条泳道等的就是本行提交 → 汇入节点
 *   - 其余泳道直穿到下一行里同一色流所在的列（泳道左移补位时就是一条斜线）
 *   - 节点连到每个父提交所在的泳道：第一个父提交接着本泳道往下，其余父提交各一条斜线
 *     （VS Code scmHistory.ts `renderSCMHistoryItemGraph`：出边按父提交所在的输出泳道画，
 *     不从泳道差异推断，所以父提交已经有泳道在等时也不会漏画合并线）
 *
 * 颜色按色流取，不按泳道位置：分支左移、翻页都不换色。
 * 这样拆的好处是渲染端不需要懂算法，算法那侧也不碰 DOM、可以单测。 */

const LANE_WIDTH = 14
const DOT = 3.5

/** 泳道配色。取自 Primer 的调色板，和 diff 那边同源，暗色下也够亮。 */
const COLORS = ["#0366d6", "#28a745", "#d73a49", "#6f42c1", "#e36209", "#005cc5", "#22863a"]

export function CommitGraph({
  lanesBefore,
  lane,
  lanesAfter,
  height,
  streamsBefore,
  streamsAfter,
  stream,
  parents,
  head,
  stash
}: {
  /** 进入这一行时各泳道等待的提交 */
  lanesBefore: (string | null)[]
  /** 这个提交所在的泳道 */
  lane: number
  /** 离开这一行时各泳道等待的提交 */
  lanesAfter: (string | null)[]
  height: number
  /** 进入 / 离开这一行时各泳道的色流。没有就按泳道位置取色、按位置对齐（旧夹具） */
  streamsBefore?: number[]
  streamsAfter?: number[]
  /** 这个提交所在泳道的色流 */
  stream?: number
  /** 这个提交的父提交。有了它出边就按父提交所在泳道画；没有就把下一行里新出现的泳道都从节点引出 */
  parents?: string[]
  /** HEAD 指向这个提交：外面加一圈 */
  head?: boolean
  /** 贮藏行：节点画成空心，与普通提交区分（贮藏不在任何分支上，只挂在基提交旁边） */
  stash?: boolean
}) {
  const width = (Math.max(lanesBefore.length, lanesAfter.length, lane + 1) + 1) * LANE_WIDTH
  const x = (i: number) => i * LANE_WIDTH + LANE_WIDTH / 2
  const mid = height / 2
  const color = (s: number) => COLORS[s % COLORS.length]
  const streamBefore = (i: number) => streamsBefore?.[i] ?? i
  const streamAfter = (i: number) => streamsAfter?.[i] ?? i
  const nodeStream = stream ?? streamBefore(lane)
  // 等着本行提交的泳道上记的就是它的 sha；第一行没人等它
  const sha = lanesBefore[lane] ?? null

  const lines: React.ReactNode[] = []
  const line = (key: string, d: string, s: number) => {
    // 泳道位置就是这条绘图路径的标识。
    lines.push(<path key={key} d={d} stroke={color(s)} fill="none" strokeWidth={1.5} />)
  }

  // 上半段：汇入节点，或者直穿到下一行
  lanesBefore.forEach((waiting, i) => {
    if (!waiting) return
    if (i === lane || waiting === sha) {
      line(`in-${i}`, curve(x(i), 0, x(lane), mid), streamBefore(i))
      return
    }
    const to =
      streamsBefore && streamsAfter
        ? streamsAfter.indexOf(streamsBefore[i])
        : lanesAfter[i] === waiting
          ? i
          : lanesAfter.indexOf(waiting)
    line(`through-${i}`, curve(x(i), 0, x(to < 0 ? i : to), height), streamBefore(i))
  })

  // 下半段：节点连到各个父提交所在的泳道
  if (parents) {
    parents.forEach((parent, k) => {
      const to =
        k === 0
          ? lanesAfter[lane] === parent
            ? lane
            : lanesAfter.indexOf(parent)
          : lanesAfter.findIndex((waiting, i) => waiting === parent && i !== lane)
      if (to < 0) return
      line(`out-${k}`, curve(x(lane), mid, x(to), height), k === 0 ? nodeStream : streamAfter(to))
    })
  } else {
    lanesAfter.forEach((waiting, i) => {
      if (!waiting || (i !== lane && lanesBefore[i] === waiting)) return
      line(`out-${i}`, curve(x(lane), mid, x(i), height), streamAfter(i))
    })
  }

  return (
    <svg width={width} height={height} className="shrink-0" aria-hidden>
      <title>提交图</title>
      {lines}
      {head && <circle cx={x(lane)} cy={mid} r={DOT + 2.5} fill="none" stroke={color(nodeStream)} strokeWidth={1.5} />}
      {stash ? (
        <circle
          cx={x(lane)}
          cy={mid}
          r={DOT + 0.5}
          fill="var(--background)"
          stroke={color(nodeStream)}
          strokeWidth={1.5}
          strokeDasharray="2 1.5"
        />
      ) : (
        <circle cx={x(lane)} cy={mid} r={DOT} fill={color(nodeStream)} />
      )}
    </svg>
  )
}

/** 同列就是直线，跨列走一段贝塞尔——直角折线在密集的图里很难看。 */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`
  const my = (y1 + y2) / 2
  return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`
}
