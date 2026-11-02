import { ArrowUpIcon, GitCompareIcon, SearchIcon } from "@primer/octicons-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { formatDistanceToNowStrict } from "date-fns"
import { CaseSensitive, CheckCheck, CircleHelp, Regex, SlidersHorizontal, WholeWord, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { usePreferencesStore } from "@/features/preferences/store"
import { avatarUrl } from "@/lib/avatar"
import { endCommitDrag, startCommitDrag } from "@/lib/commit-drag"
import { isCoAuthoredByTrailer, parseSingleUnfoldedTrailer } from "@/lib/commit-trailers"
import { dateFnsLocale } from "@/lib/date-locales"
import { formatDate } from "@/lib/format-date"
import { ipc } from "@/lib/ipc"
import { isUnpushedCommit, type LocalCommits, type PushStatus } from "@/lib/unpushed-commits"
import { cn } from "@/lib/utils"
import type { CommitInfo, Comparison, GraphRow } from "@/models/history"

import i18n from "../../lib/i18n"
import { CommitGraph } from "./graph"
import { Tags } from "./tags"

/** GitLens 搜索的四个匹配开关（SearchQuery 的 matchCase / matchWholeWord / matchRegex / matchAll） */
type SearchOption = "case" | "word" | "regex" | "all"

/** 默认同 GitLens 的 `gitCommands.search.*`：只有正则开着 */
const DEFAULT_SEARCH_OPTIONS: SearchOption[] = ["regex"]

const SEARCH_OPTIONS: { value: SearchOption; label: string; icon: typeof CaseSensitive }[] = [
  { value: "case", label: "history.matchCase", icon: CaseSensitive },
  { value: "word", label: "history.matchWholeWord", icon: WholeWord },
  { value: "regex", label: "history.matchRegex", icon: Regex },
  { value: "all", label: "history.matchAll", icon: CheckCheck }
]

/** 帮助弹层里按 GitLens 文档顺序列出的操作符 */
const SEARCH_OPERATORS = [
  "message",
  "author",
  "committer",
  "commit",
  "file",
  "change",
  "type",
  "after",
  "before",
  "ref"
] as const

/** 文件历史模式：只列改过这一个文件的提交（跟过改名），最新的在前。
 *  和普通历史一样滚到底就翻页；hasMore 为 false 时列表底下标出「已到最早的提交」 */
export interface FileHistory {
  path: string
  commits: CommitInfo[]
  hasMore: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  /** 请求还在路上。部分克隆的仓库第一次 `--follow` 要先取 blob，可能要几秒 */
  loading?: boolean
  error?: string | null
}

interface Props {
  commits: CommitInfo[]
  /** 仓库路径。搜索要用 */
  repo: string
  /** 非空就进入文件历史模式：工具栏换成路径标签 + 关闭按钮，列表换成这个文件的提交 */
  fileHistory?: FileHistory | null
  onCloseFileHistory?: () => void
  /** 提交图。为空就不画那一列——空仓库或者还没算出来时不该先占一段空白 */
  rows: GraphRow[]
  /** 翻页。列表快到底时调 onLoadMore；hasMore 为 false 时列表底下标出「已到最早的提交」。
   *  不传 hasMore 就没有翻页（stories、固定列表） */
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  selected: string | null
  onSelect: (sha: string) => void
  /** 右键菜单里的动作。对齐原版历史页的那几项 */
  onRevert: (sha: string) => void
  onCherryPick: (sha: string) => void
  onCherryPickMany: (shas: string[]) => void
  onSquashMany: (shas: string[]) => void
  /** Desktop 多选右键「Squash N Commits…」：其余所选压到右键的那条上 */
  onSquashOnto?: (toSquash: string[], onto: string) => void
  onCreateTag: (sha: string) => void
  onResetTo: (sha: string) => void
  /** Desktop onAmendCommit(commit, isLocalCommit) */
  onAmendCommit?: (sha: string, isLocal: boolean) => void
  /** Desktop onUndoCommit */
  onUndoCommit?: () => void
  /** Desktop onDeleteTag：只有还没推送的标签（tagsToPush）能删 */
  onDeleteTag?: (name: string) => void
  /** Desktop onCheckoutCommit：检出成游离 HEAD */
  onCheckoutCommit?: (commit: CommitInfo) => void
  /** Desktop onCreateBranch：以这个提交为起点新建分支 */
  onCreateBranchFromCommit?: (commit: CommitInfo) => void
  unpushedTags?: readonly string[]
  /** Desktop「View on GitHub」：GitLab 远端为「View on GitLab」 */
  viewOnLabel?: string
  /** 改写历史的那几项。index 是在 HEAD 历史（`headHistory(rows, commits)`，新的在前）里的下标：
   *  提交图从全部分支、标签和贮藏遍历，列表里相邻的两行不一定是父子 */
  onSquashIntoParent: (index: number) => void
  onMove: (index: number, direction: "older" | "newer") => void
  /** 把 HEAD 历史里第 from 条拖到第 to 条的位置上 */
  onReorder: (from: number, to: number) => void
  /** 在浏览器里打开这个提交；没有远端时为空 */
  onOpenInBrowser?: (sha: string) => void
  /** 当前分支名。对比时以它为「我方」 */
  currentBranch: string | null
  /** 远端、上游和领先数：决定哪些行带 Desktop 的「未推送」↑ 标记（`isUnpushedCommit`）。不传就不标 */
  pushStatus?: PushStatus | null
  /** 没有上游时 Desktop 的 localCommitSHAs（`HEAD --not --remotes`），由上层每次仓库刷新取一次 */
  localCommits?: LocalCommits | null
  /** 把对方合进来 */
  onMerge: (branch: string) => void
  /** 对比结果变了。上层要用它来解析「选中的提交」——对比列表里的提交
   *  多半不在当前分支的历史里，只靠 commits 找不到 */
  onCompared?: (c: Comparison | null) => void
}

/** HEAD 历史：`git log HEAD` 会列出的那些提交，按提交图的顺序。改写历史（压缩、挪动、重排）
 *  和「已推送」判断都按它的下标算。贮藏行和其它分支上的提交不在里面；没有提交图（stories、
 *  固定列表）或行上没有 onHead（旧数据）时整个列表都算 */
export function headHistory(rows: GraphRow[], commits: CommitInfo[]): CommitInfo[] {
  if (rows.length !== commits.length) return commits
  return rows.filter(row => row.stash == null && row.onHead !== false).map(row => row.commit)
}

/** 同 Desktop `commit-list.tsx` 的 RowHeight */
const ROW = 50
/** 离底部还剩几行时就翻下一页。同 Desktop 的 `CloseToBottomThreshold`（app/src/ui/history/compare.tsx） */
const LOAD_AHEAD = 10

/** 提交列表。行高固定 + 虚拟滚动，大仓库几万个提交也不卡。 */
export function HistorySidebar({
  commits,
  repo,
  fileHistory,
  onCloseFileHistory,
  rows,
  hasMore,
  loadingMore,
  onLoadMore,
  selected,
  onSelect,
  onRevert,
  onCherryPick,
  onCherryPickMany,
  onSquashMany,
  onSquashOnto,
  onCreateTag,
  onResetTo,
  onAmendCommit,
  onUndoCommit,
  onDeleteTag,
  onCheckoutCommit,
  onCreateBranchFromCommit,
  unpushedTags = [],
  viewOnLabel,
  onSquashIntoParent,
  onMove,
  onReorder,
  onOpenInBrowser,
  currentBranch,
  pushStatus,
  localCommits,
  onMerge,
  onCompared
}: Props) {
  const { t } = useTranslation()
  // 对比的那条分支。null = 不对比，看普通历史
  // 正在拖的那一行、拖到了哪一行（都是 list 里的下标）
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const anchor = useRef<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [against, setAgainst] = useState<string | null>(null)
  useEffect(() => endCommitDrag, [repo])
  const [comparison, setComparison] = useState<Comparison | null>(null)
  // 能拿来对比的分支。列表自己取——分支下拉那边也是自己取的，
  // 为了一个下拉把它提到顶层反而绕
  const [branchError, setBranchError] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [compareError, setCompareError] = useState<string | null>(null)
  const error = fileHistory?.error ?? compareError ?? searchError ?? branchError
  const [branches, setBranches] = useState<string[]>([])
  useEffect(() => {
    let active = true
    setBranches([])
    setBranchError(null)
    ipc
      .branches(repo)
      .then(bs => active && setBranches(bs.map(b => b.name)))
      .catch((e: unknown) => active && setBranchError(String(e)))
    return () => {
      active = false
    }
  }, [repo])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState("")
  const [options, setOptions] = useState<SearchOption[]>(DEFAULT_SEARCH_OPTIONS)
  const [found, setFound] = useState<CommitInfo[] | null>(null)

  // 搜索交给 git 自己的过滤器（--grep / --author / -S），不在前端筛：
  // 大仓里把几万个提交全捞出来再过滤，光传输就够慢的。
  // 查询语法由 Rust 侧按 GitLens 解析，语法错误从 reject 里回来，显示在错误槽。
  useEffect(() => {
    const q = query.trim()
    setFound(null)
    setSearchError(null)
    if (!q) return
    let active = true
    const timer = window.setTimeout(() => {
      ipc
        .searchCommits(repo, {
          query: q,
          matchAll: options.includes("all"),
          matchCase: options.includes("case"),
          matchRegex: options.includes("regex"),
          matchWholeWord: options.includes("word")
        })
        .then(value => active && setFound(value))
        .catch((e: unknown) => active && setSearchError(String(e)))
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [repo, options, query])

  // 选了对比分支就去取两边各自独有的提交。「领先几个落后几个」只是两个数字，
  // 真要判断该不该合，得看**是哪些提交**——原版的 compare 视图就是干这个的。
  // commits 更新表示仓库历史发生变化，必须重新计算分支对比。
  useEffect(() => {
    setComparison(null)
    setCompareError(null)
    onCompared?.(null)
    if (!against) return
    let stale = false
    ipc
      .compareCommits(repo, currentBranch ?? "HEAD", against, 200)
      .then(c => {
        if (stale) return
        setComparison(c)
        onCompared?.(c)
      })
      .catch((e: unknown) => {
        if (stale) return
        setCompareError(String(e))
        setComparison(null)
        onCompared?.(null)
      })
    return () => {
      stale = true
    }
  }, [repo, currentBranch, against, commits, onCompared])

  // 搜到结果时列表显示结果，图那一列不画——搜索结果不是连续历史，
  // 泳道画出来是错的。文件历史同理
  const list = fileHistory?.commits ?? found ?? commits
  const searching = query.trim().length > 0
  // 列表不是完整的 log：不画泳道、不给拖、不按下标改写历史
  const filtered = searching || !!fileHistory
  const selectedRows = list.filter(commit => selection.has(commit.sha)).map(commit => commit.sha)
  // 每个提交在 HEAD 历史里的下标；不在里面的（别的分支、贮藏）不能按 HEAD 历史改写
  const head = headHistory(rows, commits)
  const headIndex = new Map(head.map((commit, index) => [commit.sha, index]))
  const unpushed = (sha: string) => isUnpushedCommit(sha, headIndex.get(sha), pushStatus, localCommits)
  // Desktop commit-list isLocalCommit：localCommitSHAs 里的提交；没有远端的仓库（loadLocalCommits 走
  // `HEAD --not --remotes`）整条 HEAD 历史都是本地的
  const isLocal = (sha: string) => (pushStatus?.remote == null ? headIndex.has(sha) : unpushed(sha))
  // Desktop canAmendCommits 只在 History 模式（不在对比）；这里另外排除搜索结果与文件历史——下标不是 HEAD 历史的下标
  const inHistory = found === null && !fileHistory
  const stashOf = (index: number) => (filtered ? null : (rows[index]?.stash ?? null))
  // repository and filter changes invalidate the selected range.
  useEffect(() => {
    setSelection(new Set())
    anchor.current = null
  }, [repo, query, against, fileHistory?.path])

  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12
  })
  const virtualItems = virtualizer.getVirtualItems()
  const lastVisible = virtualItems.at(-1)?.index ?? -1
  // 滚到离底部不到 LOAD_AHEAD 行就翻页。搜索结果和对比视图不是连续历史，不翻；
  // 文件历史翻它自己的列表
  const pageMore = fileHistory ? fileHistory.hasMore : hasMore
  const pageBusy = fileHistory ? fileHistory.loadingMore : loadingMore
  const loadPage = fileHistory ? fileHistory.onLoadMore : searching || against ? undefined : onLoadMore
  useEffect(() => {
    if (!loadPage || !pageMore || pageBusy) return
    if (list.length - lastVisible <= LOAD_AHEAD) loadPage()
  }, [loadPage, pageMore, pageBusy, list.length, lastVisible])
  const footer = fileHistory
    ? fileHistory.commits.length > 0 &&
      (fileHistory.hasMore ? fileHistory.loadingMore && t("history.loadingMore") : t("history.end"))
    : hasMore === undefined || searching
      ? null
      : hasMore
        ? loadingMore && t("history.loadingMore")
        : t("history.end")

  const search = (
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
      {fileHistory ? (
        // 文件历史模式：搜索和对比都收起来，一行里只放路径标签和关闭按钮
        <>
          <Badge
            variant="secondary"
            className="h-7 max-w-full min-w-0 shrink justify-start font-mono text-[11px]"
            title={t("history.fileHistory", { path: fileHistory.path })}>
            <span className="min-w-0 truncate">{fileHistory.path}</span>
          </Badge>
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            aria-label={t("history.closeFileHistory")}
            title={t("history.closeFileHistory")}
            onClick={onCloseFileHistory}>
            <X />
          </Button>
        </>
      ) : (
        <>
          <InputGroup className="h-7 min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon size={12} />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={e => setQuery(e.currentTarget.value)}
              placeholder={t("history.searchPlaceholder")}
              aria-label={t("history.searchPlaceholder")}
              onKeyDown={e => e.key === "Escape" && setQuery("")}
            />
            <InputGroupAddon align="inline-end">
              {/* 区分大小写 / 全字 / 正则 / 全部满足，对应 GitLens 搜索框的四个开关；收进框内菜单，开着的选项让按钮高亮 */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <InputGroupButton
                      size="icon-xs"
                      variant={options.length > 0 ? "secondary" : "ghost"}
                      aria-label={t("history.matchOptions")}
                      title={t("history.matchOptions")}
                    />
                  }>
                  <SlidersHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{t("history.matchOptions")}</DropdownMenuLabel>
                    {SEARCH_OPTIONS.map(({ value, label, icon: Icon }) => (
                      <DropdownMenuCheckboxItem
                        key={value}
                        checked={options.includes(value)}
                        onCheckedChange={checked =>
                          setOptions(previous =>
                            checked ? [...previous, value] : previous.filter(option => option !== value)
                          )
                        }>
                        <Icon />
                        {t(label)}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* 操作符速查。只列语法，不替用户改查询 */}
              <Popover>
                <PopoverTrigger
                  render={
                    <InputGroupButton
                      size="icon-xs"
                      aria-label={t("history.searchHelp")}
                      title={t("history.searchHelp")}
                    />
                  }>
                  <CircleHelp />
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 gap-2 text-xs">
                  <PopoverHeader>
                    <PopoverTitle>{t("history.searchHelp")}</PopoverTitle>
                    <PopoverDescription className="text-xs">{t("history.searchHelpHint")}</PopoverDescription>
                  </PopoverHeader>
                  <ul className="flex flex-col gap-1">
                    {SEARCH_OPERATORS.map(operator => (
                      <li key={operator}>{t(`history.op_${operator}`)}</li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            </InputGroupAddon>
          </InputGroup>
          {/* 和哪条分支对比（原版 compare-sidebar 的分支选择）。选空就是看普通历史。
              侧栏只有 250px，收成图标菜单，对比中时按钮高亮 */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant={against ? "secondary" : "ghost"}
                  className="history-compare shrink-0"
                  aria-label={against ? `${t("history.compareWith")}: ${against}` : t("history.compareWith")}
                  title={against ? `${t("history.compareWith")}: ${against}` : t("history.compareWith")}
                />
              }>
              <GitCompareIcon size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 min-w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("history.compareWith")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={against ?? ""} onValueChange={value => setAgainst(value || null)}>
                  <DropdownMenuRadioItem value="">{t("history.noCompare")}</DropdownMenuRadioItem>
                  {branches
                    .filter(b => b !== currentBranch)
                    .map(b => (
                      <DropdownMenuRadioItem key={b} value={b}>
                        {b}
                      </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      <Tags repo={repo} />
      {selectedRows.length > 1 && (
        <>
          <span className="shrink-0 text-xs">{selectedRows.length}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={list.some((commit, index) => selection.has(commit.sha) && stashOf(index) != null)}
            onClick={() => onCherryPickMany([...selectedRows].toReversed())}>
            {t("history.cherryPick")}
          </Button>
          {!filtered && selectedRows.every(sha => headIndex.has(sha)) && (
            <Button size="sm" variant="outline" onClick={() => onSquashMany(selectedRows)}>
              {t("history.squashSelected")}
            </Button>
          )}
        </>
      )}
      {against && comparison && (
        <Button size="sm" variant="outline" disabled={comparison.behind.length === 0} onClick={() => onMerge(against)}>
          {t("history.mergeIn", { branch: against })}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-destructive truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  )

  // 对比视图：两段列表，各自是「我有对方没有的」和「对方有我没有的」。
  // 文件历史模式下对比选择器收起了，关掉文件历史再回到对比
  if (against && comparison && !fileHistory) {
    const { ahead, behind } = comparison
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {search}
        <ScrollArea className="desktop-list min-h-0 flex-1">
          <Section
            title={t("history.behindTitle", { count: behind.length, branch: against })}
            commits={behind}
            selected={selected}
            onSelect={onSelect}
            unpushed={unpushed}
            empty={t("history.compareNothing")}
          />
          <Section
            title={t("history.aheadTitle", { count: ahead.length })}
            commits={ahead}
            selected={selected}
            onSelect={onSelect}
            unpushed={unpushed}
            empty={t("history.compareNothing")}
          />
        </ScrollArea>
      </div>
    )
  }

  if (list.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {search}
        <div className="text-muted-foreground flex flex-1 items-center justify-center p-6">
          {fileHistory
            ? fileHistory.loading
              ? t("history.fileHistoryLoading")
              : t("history.fileHistoryEmpty")
            : searching
              ? t("history.noMatch")
              : t("history.empty")}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {search}
      <ScrollArea viewportRef={scrollRef} className="desktop-list min-h-0 flex-1">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map(row => {
            const c = list[row.index]
            const i = row.index
            const on = selection.size ? selection.has(c.sha) : c.sha === selected
            const stash = stashOf(i)
            // 在 HEAD 历史里的下标；过滤后的列表沿用原来的行为（不改写历史，回滚、重置照给）
            const h = headIndex.get(c.sha)
            const onHead = filtered || h !== undefined
            return (
              <div
                key={c.sha}
                className={cn(
                  "absolute inset-x-0 top-0",
                  // 拖到哪一行上面，那行顶上画一条线——落点就在这条线的位置
                  dragOver === i && dragging !== null && dragging !== i ? "border-primary border-t-2" : ""
                )}
                style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                // 拖动重排。搜索结果里不给拖：那时的下标不是 log 里的下标，
                // 照着它算落点会错位
                draggable={!filtered && stash == null}
                onDragStart={e => {
                  setDragging(i)
                  const chosen = selection.has(c.sha) ? selection : new Set([c.sha])
                  startCommitDrag(
                    e.dataTransfer,
                    repo,
                    list
                      .filter(commit => chosen.has(commit.sha))
                      .map(commit => commit.sha)
                      .toReversed()
                  )
                  // Firefox 不设 data 就不触发 drag
                  e.dataTransfer.setData("text/plain", c.sha)
                }}
                onDragOver={e => {
                  if (dragging === null) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = "move"
                  setDragOver(i)
                }}
                onDragEnd={() => {
                  endCommitDrag()
                  setDragging(null)
                  setDragOver(null)
                }}
                onDrop={e => {
                  e.preventDefault()
                  endCommitDrag()
                  const from = dragging
                  setDragging(null)
                  setDragOver(null)
                  if (from === null || from === i) return
                  // 重排只在 HEAD 历史里成立：拖的和落点都得在里面
                  const source = headIndex.get(list[from]?.sha ?? "")
                  if (source === undefined || h === undefined) return
                  onReorder(source, h)
                }}>
                <ContextMenu>
                  <ContextMenuTrigger
                    render={
                      <Item
                        size="sm"
                        onClick={event => {
                          if (event.shiftKey && anchor.current !== null) {
                            const start = Math.min(anchor.current, i),
                              end = Math.max(anchor.current, i)
                            setSelection(new Set(list.slice(start, end + 1).map(commit => commit.sha)))
                          } else if (event.metaKey || event.ctrlKey) {
                            setSelection(previous => {
                              const next = new Set(previous.size ? previous : selected ? [selected] : [])
                              if (next.has(c.sha)) next.delete(c.sha)
                              else next.add(c.sha)
                              return next
                            })
                            anchor.current = i
                          } else {
                            setSelection(new Set([c.sha]))
                            anchor.current = i
                          }
                          onSelect(c.sha)
                        }}
                        // 原版 `.commit`：左 10px、右 15px（给滚动条留位）、底边线；
                        // 选中色、焦点态由 desktop.css 的 `.desktop-list-row` 提供，行可聚焦才有焦点态
                        data-selected={on || undefined}
                        tabIndex={-1}
                        className="desktop-list-row h-full cursor-default rounded-none border-b py-0 pr-[15px] pl-2.5"
                      />
                    }>
                    {/* 提交图那一列。搜索结果和文件历史不是连续历史，画泳道是错的，所以不画 */}
                    {!filtered && rows[row.index] && (
                      <CommitGraph
                        lanesBefore={rows[row.index - 1]?.lanes ?? []}
                        streamsBefore={rows[row.index - 1]?.streams ?? []}
                        lane={rows[row.index].lane}
                        lanesAfter={rows[row.index].lanes}
                        streamsAfter={rows[row.index].streams}
                        stream={rows[row.index].stream}
                        parents={rows[row.index].commit.parentSHAs}
                        head={!!rows[row.index].head}
                        stash={stash != null}
                        height={ROW}
                      />
                    )}
                    {/* 原版 `.info .description { margin-top: 3px }`，摘要 semibold */}
                    <ItemContent className="min-w-0 gap-[3px]">
                      <ItemTitle className="flex w-full min-w-0 items-center gap-1.5 text-xs font-semibold">
                        {/* 贮藏行：虚线框标出 stash@{n}，和分支、标签的实底标记区分 */}
                        {stash != null && (
                          <Badge
                            variant="outline"
                            title={t("history.stashRow", {
                              ref: `stash@{${stash}}`,
                              base: c.parentSHAs[0]?.slice(0, 7) ?? ""
                            })}
                            className="text-muted-foreground h-4 rounded border-dashed px-1 text-[10px] font-normal">
                            {t("history.stashBadge", { index: stash })}
                          </Badge>
                        )}
                        {/* 原版空摘要显示 "Empty commit message" 并用次级色 */}
                        <span
                          className={cn("min-w-0 flex-1 truncate", !c.summary && "text-muted-foreground")}
                          title={c.summary}>
                          {c.summary || t("history.emptySummary")}
                        </span>
                        {/* 指向这个提交的分支 / 标签：原版 tag-indicator 在摘要右侧，最多占一半宽 */}
                        {!filtered && !!rows[row.index]?.refs.length && (
                          <span className="flex max-w-1/2 min-w-0 shrink-0 justify-end gap-1">
                            {rows[row.index].refs.map((r, k) => (
                              <span
                                // 同短名的本地分支和远端跟踪分支可能挂在同一个提交上
                                key={`${k}:${r}`}
                                title={r}
                                className={cn(
                                  "list-badge max-w-20 shrink truncate rounded px-1 text-[10px] leading-4",
                                  // HEAD 所在的分支加粗
                                  rows[row.index].head === r && "font-semibold"
                                )}>
                                {r}
                              </span>
                            ))}
                          </span>
                        )}
                      </ItemTitle>
                      <CommitByline commit={c} />
                    </ItemContent>
                    {unpushed(c.sha) && <UnpushedIndicator title={t("history.unpushed")} />}
                  </ContextMenuTrigger>

                  <ContextMenuContent>
                    {stash != null ? (
                      // 贮藏行只有复制 SHA：它不在任何分支上，Desktop 的历史列表里也没有这种行
                      <ContextMenuItem onClick={() => void navigator.clipboard.writeText(c.sha)}>
                        {t("history.copySha")}
                      </ContextMenuItem>
                    ) : selectedRows.length > 1 && selection.has(c.sha) ? (
                      // Desktop getContextMenuMultipleCommits。「Reorder N Commits…」是键盘重排模式，本项目没有，不列
                      <>
                        <ContextMenuItem
                          disabled={list.some((commit, index) => selection.has(commit.sha) && stashOf(index) != null)}
                          onClick={() => onCherryPickMany([...selectedRows].toReversed())}>
                          {t("history.cherryPickCommits", { count: selectedRows.length })}
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={!onSquashOnto || filtered || !selectedRows.every(sha => headIndex.has(sha))}
                          onClick={() =>
                            onSquashOnto?.(
                              selectedRows.filter(sha => sha !== c.sha),
                              c.sha
                            )
                          }>
                          {t("history.squashCommitsEllipsis", { count: selectedRows.length })}
                        </ContextMenuItem>
                      </>
                    ) : (
                      <CommitContextMenuItems
                        commit={c}
                        headIndex={inHistory ? h : undefined}
                        isLocal={isLocal(c.sha)}
                        isResettable={inHistory && h !== undefined && h > 0 && isLocal(head[h - 1]?.sha ?? "")}
                        canRewrite={inHistory && h !== undefined}
                        isLastOnHead={h !== undefined && h + 1 >= head.length}
                        onHead={!!onHead}
                        unpushedTags={unpushedTags}
                        viewOnLabel={viewOnLabel}
                        onAmendCommit={onAmendCommit}
                        onUndoCommit={onUndoCommit}
                        onResetTo={onResetTo}
                        onSquashIntoParent={onSquashIntoParent}
                        onMove={onMove}
                        onRevert={onRevert}
                        onCreateTag={onCreateTag}
                        onDeleteTag={onDeleteTag}
                        isCurrent={head[0]?.sha === c.sha}
                        onCheckoutCommit={onCheckoutCommit}
                        onCreateBranchFromCommit={onCreateBranchFromCommit}
                        onCherryPick={onCherryPick}
                        onOpenInBrowser={onOpenInBrowser}
                      />
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              </div>
            )
          })}
        </div>
        {/* 列表的尽头：正在翻页，或者已经到最早的提交 */}
        {footer && (
          <div role="status" className="text-muted-foreground flex h-9 items-center justify-center text-[11px]">
            {footer}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

/** 相对时间。用 Intl.RelativeTimeFormat，按界面语言而不是系统语言。 */
function relativeTime(unixSeconds: number): string {
  return formatDistanceToNowStrict(unixSeconds * 1000, { addSuffix: true, locale: dateFnsLocale(i18n.language) })
}

/** 对比视图里的一段：一个小标题 + 几行提交。
 *
 * 这里不做虚拟滚动——两条分支分叉几百个提交已经很少见，
 * 真到那个量级，该看的也不是这个列表了。 */
function Section({
  title,
  commits,
  selected,
  onSelect,
  unpushed,
  empty
}: {
  title: string
  commits: CommitInfo[]
  selected: string | null
  onSelect: (sha: string) => void
  unpushed: (sha: string) => boolean
  empty: string
}) {
  const { t } = useTranslation()
  return (
    <div>
      <div className="bg-muted/50 text-muted-foreground sticky top-0 px-3 py-1 text-[11px] font-semibold">{title}</div>
      {commits.length === 0 ? (
        <div className="text-muted-foreground px-3 py-2">{empty}</div>
      ) : (
        commits.map(c => (
          <Item
            key={c.sha}
            size="sm"
            tabIndex={-1}
            onClick={() => onSelect(c.sha)}
            data-selected={c.sha === selected || undefined}
            className="desktop-list-row flex h-auto w-full cursor-default flex-col items-start gap-0.5 rounded-none px-3 py-1.5 text-left">
            <span className="flex w-full min-w-0 items-center">
              <span className="min-w-0 flex-1 truncate text-xs">{c.summary}</span>
              {unpushed(c.sha) && <UnpushedIndicator title={t("history.unpushed")} />}
            </span>
            <CommitByline commit={c} />
          </Item>
        ))
      )}
    </div>
  )
}

/** 提交的作者加 Co-authored-by 共同作者。Desktop 的 coAuthors 来自 `%(trailers:unfold,only)`，
 *  即消息最后一段里的 trailer；这里从正文最后一段取同样的行。 */
const commitAuthors = (commit: CommitInfo) => {
  const authors = [{ name: commit.authorName, email: commit.authorEmail }]
  const last =
    commit.body
      .trimEnd()
      .split(/\n\s*\n/)
      .at(-1) ?? ""
  for (const line of last.split("\n")) {
    const trailer = parseSingleUnfoldedTrailer(line, ":")
    const match = trailer && isCoAuthoredByTrailer(trailer) ? /^(.*?)\s*<([^>]*)>/.exec(trailer.value) : null
    if (match) authors.push({ name: match[1], email: match[2] })
  }
  return authors
}

/** Desktop `commit-list-item.tsx` 的 `.description`：AvatarStack，再接 CommitAttribution 与 ` • ` 相对时间
 *  （两人列名字，三人以上写「N people」）。 */
function CommitByline({ commit }: { commit: CommitInfo }) {
  const { t } = useTranslation()
  const authors = commitAuthors(commit)
  // Desktop commit-list-item renderRelativeTime：「外观 › 优先显示绝对日期」
  const preferAbsoluteDates = usePreferencesStore(s => s.preferAbsoluteDates)
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="flex shrink-0">
        {authors.slice(0, 3).map((author, index) => (
          <Avatar
            key={`${index}:${author.email}`}
            size="sm"
            className={cn("ring-background data-[size=sm]:size-4", index > 0 && "-ml-1.5 ring-1")}
            title={`${author.name} <${author.email}>`}>
            <AvatarImage src={avatarUrl(author.email, 32)} alt={author.name} loading="lazy" />
            <AvatarFallback className="text-foreground group-data-[size=sm]/avatar:text-[10px]">
              {author.name.trim().slice(0, 1).toUpperCase() || "?"}
            </AvatarFallback>
          </Avatar>
        ))}
      </span>
      <ItemDescription className="min-w-0 flex-1 truncate text-[11px]">
        {authors.length > 2
          ? t("history.peopleCount", { count: authors.length })
          : authors.map(author => author.name).join(", ")}
        {` • ${preferAbsoluteDates ? formatDate(new Date(commit.time * 1000)) : relativeTime(commit.time)}`}
      </ItemDescription>
    </div>
  )
}

/** Desktop `commit-list-item.tsx` renderUnpushedIndicator + `_commit-list.scss` .commit-indicators /
 *  .unpushed-indicator：靠右、16px 高、左距 10px、徽章圆角 8px、左右 5px、徽章色按选中态换（list-badge）。 */
function UnpushedIndicator({ title }: { title: string }) {
  return (
    <span className="commit-indicators ml-2.5 flex h-4 max-w-1/2 shrink-0 justify-end leading-4">
      <span className="list-badge ml-[5px] flex h-full items-center rounded-lg px-[5px]" title={title}>
        <ArrowUpIcon size={16} />
      </span>
    </span>
  )
}

interface CommitContextMenuItemsProps {
  commit: CommitInfo
  /** 在 HEAD 历史里的下标；搜索结果、文件历史或不在 HEAD 历史里时为 undefined */
  headIndex: number | undefined
  isLocal: boolean
  isResettable: boolean
  canRewrite: boolean
  isLastOnHead: boolean
  onHead: boolean
  unpushedTags: readonly string[]
  viewOnLabel?: string
  onAmendCommit?: (sha: string, isLocal: boolean) => void
  onUndoCommit?: () => void
  onResetTo: (sha: string) => void
  onSquashIntoParent: (index: number) => void
  onMove: (index: number, direction: "older" | "newer") => void
  onRevert: (sha: string) => void
  onCreateTag: (sha: string) => void
  onDeleteTag?: (name: string) => void
  /** 是不是当前检出的提交：原版 canBeCheckedOut = row > 0 */
  isCurrent: boolean
  onCheckoutCommit?: (commit: CommitInfo) => void
  onCreateBranchFromCommit?: (commit: CommitInfo) => void
  onCherryPick: (sha: string) => void
  onOpenInBrowser?: (sha: string) => void
}

/** Desktop commit-list.tsx getContextMenuForSingleCommit：项目顺序与启用条件照原版。
 *  Reorder Commit（键盘重排模式）由原有的「往前挪 / 往后挪 / 压进上一个」代替。 */
function CommitContextMenuItems({
  commit,
  headIndex: row,
  isLocal,
  isResettable,
  canRewrite,
  isLastOnHead,
  onHead,
  unpushedTags,
  viewOnLabel,
  onAmendCommit,
  onUndoCommit,
  onResetTo,
  onSquashIntoParent,
  onMove,
  onRevert,
  onCreateTag,
  onDeleteTag,
  isCurrent,
  onCheckoutCommit,
  onCreateBranchFromCommit,
  onCherryPick,
  onOpenInBrowser
}: CommitContextMenuItemsProps) {
  const { t } = useTranslation()
  const canBeUndone = onUndoCommit !== undefined && isLocal && row === 0
  const canBeAmended = onAmendCommit !== undefined && row === 0
  const tags = commit.tags
  return (
    <>
      {canBeAmended && (
        <ContextMenuItem onClick={() => onAmendCommit(commit.sha, isLocal)}>{t("history.amendCommit")}</ContextMenuItem>
      )}
      {canBeUndone && <ContextMenuItem onClick={onUndoCommit}>{t("history.undoCommit")}</ContextMenuItem>}
      <ContextMenuItem disabled={!isResettable} onClick={() => onResetTo(commit.sha)}>
        {t("history.resetToCommit")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={isCurrent || onCheckoutCommit === undefined}
        onClick={() => onCheckoutCommit?.(commit)}>
        {t("history.checkoutCommit")}
      </ContextMenuItem>
      {canRewrite && row !== undefined && (
        <>
          <ContextMenuItem disabled={isLastOnHead} onClick={() => onMove(row, "older")}>
            {t("history.moveOlder")}
          </ContextMenuItem>
          <ContextMenuItem disabled={row === 0} onClick={() => onMove(row, "newer")}>
            {t("history.moveNewer")}
          </ContextMenuItem>
          <ContextMenuItem disabled={isLastOnHead} onClick={() => onSquashIntoParent(row)}>
            {t("history.squashIntoParent")}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuItem disabled={!onHead} onClick={() => onRevert(commit.sha)}>
        {t("history.revertChangesInCommit")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onCreateBranchFromCommit?.(commit)}>
        {t("history.createBranchFromCommit")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCreateTag(commit.sha)}>{t("history.createTag")}</ContextMenuItem>
      {onDeleteTag && tags.length === 1 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!unpushedTags.includes(tags[0])} onClick={() => onDeleteTag(tags[0])}>
            {t("history.deleteTagName", { name: tags[0] })}
          </ContextMenuItem>
        </>
      )}
      {onDeleteTag && tags.length > 1 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t("history.deleteTag")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {tags.map(name => (
                <ContextMenuItem key={name} disabled={!unpushedTags.includes(name)} onClick={() => onDeleteTag(name)}>
                  {name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        </>
      )}
      <ContextMenuItem onClick={() => onCherryPick(commit.sha)}>{t("history.cherryPickCommit")}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void navigator.clipboard.writeText(commit.sha)}>
        {t("history.copySha")}
      </ContextMenuItem>
      <ContextMenuItem disabled={tags.length === 0} onClick={() => void navigator.clipboard.writeText(tags.join(" "))}>
        {t(tags.length > 1 ? "history.copyTags" : "history.copyTag")}
      </ContextMenuItem>
      <ContextMenuItem disabled={isLocal || !onOpenInBrowser} onClick={() => onOpenInBrowser?.(commit.sha)}>
        {viewOnLabel ?? t("history.viewOnGitHub")}
      </ContextMenuItem>
    </>
  )
}
