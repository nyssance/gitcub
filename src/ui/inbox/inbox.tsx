import { AlertIcon, ArrowUpIcon, GitPullRequestIcon, RepoIcon, XCircleFillIcon } from "@primer/octicons-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { ipc } from "@/lib/ipc"
import { mapLimit } from "@/lib/map-limit"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"

/** 待我处理。
 *
 * 对着 GitLens 的 Launchpad 做，但只收「真的要你动手」的东西，不做信息流：
 *   - 有冲突没解决
 *   - 有提交还没推
 *   - 自己开的 PR / MR 的 CI 挂了
 *
 * 一条都没有时明确说「没有待办」——这里的空是好消息，不是出错。 */

/** 同时问几个本地仓库。每个摘要都要打开仓库、读索引，几百个一起开会把文件描述符用光 */
const localConcurrency = 4

interface Item {
  kind: "conflict" | "unpushed" | "ci" | "review"
  /** 本地仓库路径；远端来的条目没有 */
  repo: string | null
  title: string
  detail: string
  /** 远端条目点开是网页 */
  url?: string
}

export function Inbox({
  repositories,
  hosts,
  onOpenRepo
}: {
  repositories: string[]
  /** 已登录的实例 */
  hosts: string[]
  onOpenRepo: (repo: string) => void
}) {
  const { t } = useTranslation()
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(true)
  const [errors, setErrors] = useState<string[]>([])
  const [revision, setRevision] = useState(0)

  // revision explicitly triggers a fresh request from the refresh button.
  useEffect(() => {
    let live = true
    setBusy(true)
    const found: Item[] = []
    const failures: string[] = []

    // 本地状态：冲突、未推送。这两个不花网络。
    // 用只读引用和索引的摘要，不用完整 status：完整 status 要遍历工作区找未跟踪文件，
    // 列表里几百个仓库一起跑会把 CPU 和文件描述符打满。摘要也限并发，别一口气打开几百个仓库。
    const work = mapLimit(repositories, localConcurrency, async repo => {
      try {
        const status = await ipc.repoSummary(repo)
        const conflicts = status.conflicts
        if (conflicts.length > 0) {
          found.push({
            kind: "conflict",
            repo,
            title: t("inbox.conflict", { count: conflicts.length }),
            detail: conflicts.slice(0, 3).join("、")
          })
        }
        if (status.ahead > 0) {
          found.push({
            kind: "unpushed",
            repo,
            title: t("inbox.unpushed", { count: status.ahead }),
            detail: status.branch ?? ""
          })
        } else if (status.remote && !status.hasUpstream) {
          // 有远端却没设上游＝这条分支从没推上去过。ahead 在这种情况下恒为 0
          // （没有上游可比），光看 ahead 会把它漏掉
          found.push({
            kind: "unpushed",
            repo,
            title: t("inbox.neverPushed"),
            detail: status.branch ?? ""
          })
        }
      } catch (error) {
        failures.push(`${repo}: ${String(error)}`)
      }
    })

    // 远端那半用搜索接口一次问完：逐个仓库轮询的请求数等于本地仓库数，
    // 而且只看得见你本地有的那些仓库——「等我评审」根本不在本地
    const remote = hosts.flatMap(host =>
      (["reviewRequested", "authored"] as const).map(async kind => {
        try {
          const prs = await ipc.involvedPrs(host, kind, true)
          for (const pr of prs) {
            if (kind === "authored" && pr.checks !== "failure") continue
            found.push({
              kind: kind === "authored" ? "ci" : "review",
              repo: null,
              title: t(kind === "authored" ? "inbox.ciFailed" : "inbox.reviewRequested"),
              detail: `${pr.head} #${pr.number} ${pr.title}`,
              url: pr.url
            })
          }
        } catch (error) {
          failures.push(
            `${host} · ${t(kind === "authored" ? "inbox.ciFailed" : "inbox.reviewRequested")}: ${String(error)}`
          )
        }
      })
    )

    Promise.all([work, ...remote]).then(() => {
      if (!live) return
      setItems(found.toSorted((a, b) => `${a.kind}-${a.repo ?? a.url}`.localeCompare(`${b.kind}-${b.repo ?? b.url}`)))
      setErrors(failures.toSorted())
      setBusy(false)
    })
    return () => {
      live = false
    }
  }, [repositories, hosts, t, revision])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b px-3">
        <span className="text-xs font-semibold whitespace-nowrap">{t("inbox.title")}</span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setRevision(value => value + 1)}>
          {busy && <Spinner data-icon="inline-start" />}
          {t("inbox.refresh")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={busy}>
        {!busy && errors.length > 0 && (
          <div role="alert" className="text-destructive px-3 py-2 text-xs">
            <p>{t("inbox.loadFailed")}</p>
            {errors.map(error => (
              <p key={error} className="break-words">
                {error}
              </p>
            ))}
          </div>
        )}
        {!busy && items.length === 0 && errors.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("inbox.clear")}</EmptyTitle>
              <EmptyDescription>{t("inbox.clearHint")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {items.map(item => (
          <div
            key={`${item.repo ?? item.url}-${item.kind}`}
            className="hover:bg-accent/50 flex h-14 items-center gap-3 border-b px-3">
            <Icon kind={item.kind} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{item.title}</div>
              <div className="text-muted-foreground flex items-center gap-2 truncate text-[11px]">
                <RepoIcon size={11} className="shrink-0" />
                <span className="shrink-0">{item.repo?.split("/").pop() ?? ""}</span>
                <span className="truncate">{item.detail}</span>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => (item.repo ? onOpenRepo(item.repo) : item.url && void openUrl(item.url))}>
              {t("inbox.go")}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function Icon({ kind }: { kind: Item["kind"] }) {
  if (kind === "review") return <GitPullRequestIcon size={16} className="text-status-renamed shrink-0" />
  if (kind === "conflict") return <AlertIcon size={16} className="text-destructive shrink-0" />
  if (kind === "ci") return <XCircleFillIcon size={16} className="text-destructive shrink-0" />
  return <ArrowUpIcon size={16} className="text-status-modified shrink-0" />
}
