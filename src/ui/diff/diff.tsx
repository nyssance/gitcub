import { AlertIcon } from "@primer/octicons-react"
import { listen } from "@tauri-apps/api/event"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { diffKind, type DiffTokens, expandDiff, fileKindOf, getDiff, selectableLines } from "@/lib/diff"
import { diffLineMapping, projectDiffSelection, restoreDiffSelection } from "@/lib/diff-selection-mapping"
import { ipc } from "@/lib/ipc"
import type { ImageDiff as ImageDiffData } from "@/models/app-state"
import { ImageDiffView } from "@/ui/diff/image"
import { Path } from "@/ui/shared/path"
import { DiffParser } from "@/upstream/lib/diff-parser"
import { type DiffHunk, DiffHunkExpansionType, DiffType, type IRawDiff } from "@/upstream/models/diff"
import type { DiffSelection } from "@/upstream/models/diff/diff-selection"
import type { DiffExpansionKind } from "@/upstream/ui/diff/text-diff-expansion"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger
} from "../base/context-menu"
import { Input } from "../base/input"
import { DiffOptions } from "./diff-options"
import { SplitDiff } from "./split-diff"

interface Props {
  hideWhitespace?: boolean
  onHideWhitespaceChange?: (hide: boolean) => void
  onSearchResults?: (result: { current: number; total: number }) => void
  onTextContext?: (actions: { text: string; selectAll: () => void }) => void
  onDiscardLines?: (diff: IRawDiff, lines: number[]) => void

  controls?: React.ReactNode
  /** 文件状态图标，放在标题行最右（原版 DiffHeader：PathLabel、diff 选项、状态 Octicon） */
  status?: React.ReactNode
  split?: boolean
  wrap?: boolean
  query?: string
  searchStep?: number
  file: string | null
  diff: IRawDiff | null
  selection: DiffSelection | null
  onSelectionChange?: (next: DiffSelection) => void
  error: string | null
  readOnly?: boolean
  /** 两侧分别词法分析的结果；没有就不着色 */
  tokens?: DiffTokens
  /** 点 hunk 头上的 ↑/↓ 展开更多上下文 */
  onExpand?: (hunk: DiffHunk, kind: DiffExpansionKind) => void
  /** git 说它会改写这个文件的行尾（core.autocrlf）。有值就在 diff 上方说一句 */
  lineEndings?: { from: string; to: string } | null
  /** 仓库路径 + 提交（看历史时）。二进制文件是图片时要拿这两个去取图 */
  repo?: string | null
  sha?: string | null
  /** 看历史时，重命名或复制前的路径 */
  oldPath?: string | null
  /** 右键落点。给的是统一 diff 下标：这一行，以及它所在的整块。
   *  落在上下文行（没什么可丢弃的）上时给 null。 */
  onContextLine?: (at: { line: number; hunk: number[] } | null) => void
}

/** diff 视图。
 *
 * 数据来自移植自原版的 DiffParser（`IRawDiff` / `DiffHunk` / `DiffLine`），
 * 统一和并排视图共用 Desktop 的行构造与行组件。 */
export function DiffView(props: Props) {
  return <FileDiffView key={JSON.stringify([props.repo, props.file, props.sha])} {...props} />
}

function FileDiffView(props: Props) {
  const { t } = useTranslation()
  const [split, setSplit] = useState(() => localStorage.getItem("diff-layout") === "split")
  const [wrap, setWrap] = useState(() => localStorage.getItem("diff-wrap") !== "false")
  const [hide, setHide] = useState(false)
  const [filtered, setFiltered] = useState<IRawDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [searchResults, setSearchResults] = useState({ current: 0, total: 0 })
  const [searchStep, setSearchStep] = useState(0)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const subscription = listen<string>("menu", event => {
      if (event.payload === "find-text") search.current?.focus()
    })
    return () => {
      void subscription.then(dispose => dispose())
    }
  }, [])
  // refresh the filtered projection whenever the canonical diff changes.
  useEffect(() => {
    if (!hide || !props.repo || !props.file) {
      setFiltered(null)
      setError(null)
      return
    }
    let active = true
    setFiltered(null)
    setError(null)
    const repo = props.repo
    const file = props.file
    const sha = props.sha
    const result = sha
      ? ipc.commitFileDiff(repo, sha, file, props.oldPath ?? null, true).then(text => new DiffParser().parse(text))
      : ipc.repoStatus(repo).then(status => {
          const change = status.changes.find(c => c.path === file)
          return getDiff(repo, file, fileKindOf(change ?? { kind: "unstaged", change: "modified" }), true).then(
            result => result.diff
          )
        })
    void result.then(diff => active && setFiltered(diff)).catch(e => active && setError(String(e)))
    return () => {
      active = false
    }
  }, [hide, props.repo, props.file, props.sha, props.oldPath, props.diff])
  const [expanded, setExpanded] = useState<{ source: IRawDiff; diff: IRawDiff } | null>(null)
  const [expanding, setExpanding] = useState(false)
  const [textActions, setTextActions] = useState<{ text: string; selectAll: () => void } | null>(null)
  const [menuAt, setMenuAt] = useState<{ source: IRawDiff; line: number; hunk: number[] } | null>(null)
  const generation = useRef(0)
  const expansionLock = useRef(false)
  useEffect(() => {
    const lifecycle = generation
    lifecycle.current++
    expansionLock.current = false
    setExpanding(false)
    setMenuAt(null)
    return () => {
      lifecycle.current++
    }
  }, [props.diff, hide])
  const displayed = expanded?.source === props.diff ? expanded.diff : props.diff
  const visual = hide ? filtered : displayed
  const canExpand = !hide && !!props.repo && !!props.file && !!visual && !visual.isBinary
  const expand = async (target: { hunk: DiffHunk; kind: DiffExpansionKind } | null) => {
    if (!canExpand || !props.repo || !props.file || !visual || !props.diff || expansionLock.current) return
    expansionLock.current = true
    setExpanding(true)
    setError(null)
    const revision = generation.current
    try {
      const next = await expandDiff(props.repo, props.file, visual, target, props.sha)
      if (revision === generation.current && next) setExpanded({ source: props.diff, diff: next })
    } catch (e) {
      if (revision === generation.current) setError(String(e))
    } finally {
      if (revision === generation.current) {
        expansionLock.current = false
        setExpanding(false)
      }
    }
  }
  const mapping = useMemo(
    () => (props.diff && filtered ? diffLineMapping(props.diff, filtered) : []),
    [props.diff, filtered]
  )
  const selection =
    hide && props.selection && visual
      ? projectDiffSelection(props.selection, mapping, selectableLines(visual))
      : props.selection
  const controls = (
    <>
      <Input
        ref={search}
        aria-label={t("diff.search")}
        placeholder={t("diff.search")}
        className="h-7 w-28 shrink-0"
        value={query}
        onChange={e => {
          setQuery(e.currentTarget.value)
          setSearchStep(0)
        }}
        onKeyDown={e => {
          if (e.key === "Enter") setSearchStep(v => v + (e.shiftKey ? -1 : 1))
          if (e.key === "Escape") setQuery("")
        }}
      />
      {query && (
        <span role="status" className="text-muted-foreground shrink-0 text-xs">
          {searchResults.current}/{searchResults.total}
        </span>
      )}
      <DiffOptions
        isInteractiveDiff={!!props.onSelectionChange}
        hideWhitespaceChanges={hide}
        onHideWhitespaceChangesChanged={setHide}
        showSideBySideDiff={split}
        onShowSideBySideDiffChanged={value => {
          setSplit(value)
          localStorage.setItem("diff-layout", value ? "split" : "unified")
        }}
        wrap={wrap}
        onWrapChanged={value => {
          setWrap(value)
          localStorage.setItem("diff-wrap", String(value))
        }}
      />
    </>
  )
  // Keep controls available during a filtered reload or error so the user can recover.
  if (hide && !visual)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b px-3">{controls}</div>
        <Centered>{error ?? t("diff.loading")}</Centered>
      </div>
    )
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div className="flex min-h-0 flex-1 flex-col" />}
        onContextMenuCapture={() => {
          setMenuAt(null)
          setTextActions(null)
        }}>
        {error && (
          <div role="alert" className="text-destructive px-3 text-xs">
            {error}
          </div>
        )}
        <TextDiffView
          {...props}
          hideWhitespace={hide}
          onHideWhitespaceChange={setHide}
          onTextContext={setTextActions}
          onSearchResults={setSearchResults}
          diff={visual}
          controls={controls}
          split={split}
          wrap={wrap}
          query={query}
          searchStep={searchStep}
          selection={selection}
          onExpand={canExpand && !expanding ? (hunk, kind) => void expand({ hunk, kind }) : undefined}
          onSelectionChange={next => {
            if (!props.selection) return
            props.onSelectionChange?.(hide ? restoreDiffSelection(props.selection, next, mapping) : next)
          }}
          onContextLine={at => {
            // Desktop disables line-discard actions in the whitespace projection.
            if (!hide && !props.readOnly && at && props.diff) setMenuAt({ ...at, source: props.diff })
            else setMenuAt(null)
            props.onContextLine?.(hide ? null : at)
          }}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem
            disabled={!textActions?.text}
            onClick={() => {
              if (textActions?.text)
                void navigator.clipboard.writeText(textActions.text).catch(e => setError(String(e)))
            }}>
            {t("diff.copy")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!textActions} onClick={() => textActions?.selectAll()}>
            {t("diff.selectAll")}
          </ContextMenuItem>
          {props.onDiscardLines && !props.readOnly && (
            <>
              <ContextMenuItem
                variant="destructive"
                disabled={hide || menuAt?.source !== props.diff}
                onClick={() => {
                  if (!hide && menuAt?.source === props.diff) props.onDiscardLines?.(menuAt.source, [menuAt.line])
                }}>
                {t("diff.discardLine")}
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                disabled={hide || menuAt?.source !== props.diff}
                onClick={() => {
                  if (!hide && menuAt?.source === props.diff) props.onDiscardLines?.(menuAt.source, menuAt.hunk)
                }}>
                {t("diff.discardHunk")}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem
            disabled={
              !canExpand ||
              expanding ||
              (!expanded && visual?.hunks.length === 1 && visual.hunks[0].expansionType === DiffHunkExpansionType.None)
            }
            onClick={() => (expanded?.source === props.diff ? setExpanded(null) : void expand(null))}>
            {t(expanded?.source === props.diff ? "diff.collapse" : "diff.expandAll")}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function TextDiffView({
  controls,
  split = false,
  wrap = true,
  query = "",
  searchStep = 0,
  file,
  diff,
  selection,
  onSelectionChange,
  error,
  readOnly,
  onExpand,
  onContextLine,
  onTextContext,
  hideWhitespace,
  onHideWhitespaceChange,
  onSearchResults,
  lineEndings,
  repo,
  sha,
  tokens
}: Props) {
  const { t } = useTranslation()
  if (!file) return <Centered>{t("diff.selectFile")}</Centered>
  if (error) return <Centered className="text-destructive">{error}</Centered>
  if (!diff) return <Centered>{t("diff.loading")}</Centered>
  // 二进制文件没有「行」可比。图片有它自己的看法（两版摆出来比），
  // 其余的至少要说清楚是二进制——掉进下面那个「没有改动」等于撒谎。
  if (diff.isBinary) {
    return diffKind(diff, file) === DiffType.Image && repo ? (
      <ImagePane repo={repo} file={file} sha={sha ?? null} />
    ) : (
      <Centered>{t("diff.binary")}</Centered>
    )
  }

  return (
    <div className="diff-container flex min-h-0 flex-1 flex-col">
      {/* 原版 `.diff-container .header`：左右 10px 内边距，路径是正文字体、目录淡化，状态图标在最右 */}
      <div className="flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-b px-2.5 whitespace-nowrap">
        <Path path={file} className="min-w-12 flex-1 text-xs" />
        <span className="text-muted-foreground shrink-0 text-xs">
          {t("diff.hunkCount", { count: diff.hunks.length })}
        </span>
        {controls}
        {status && <span className="flex shrink-0 items-center [&_svg]:size-4">{status}</span>}
      </div>
      {/* 双向文字控制符在编辑器里是隐形的，却能让代码「看起来」和「实际编译的」
          完全是两回事（Trojan Source，CVE-2021-42574）。原版也是在 diff 上方
          挂一条警告——解析器早就算出来了，不说出来等于白算。 */}
      {lineEndings && (
        <div className="bg-muted/50 text-muted-foreground flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-xs">
          <AlertIcon size={14} />
          {t("diff.lineEndings", { from: lineEndings.from, to: lineEndings.to })}
        </div>
      )}
      {diff.hasHiddenBidiChars && (
        <div className="bg-destructive/10 text-destructive flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-xs">
          <AlertIcon size={14} />
          {t("diff.bidi")}
        </div>
      )}
      {diff.hunks.length === 0 ? (
        <Centered>{t("diff.noChanges")}</Centered>
      ) : (
        <SplitDiff
          split={split}
          tokens={tokens}
          wrap={wrap}
          diff={diff}
          selection={selection}
          onChange={readOnly ? undefined : onSelectionChange}
          onExpand={onExpand}
          onContextLine={onContextLine}
          hideWhitespace={hideWhitespace}
          onHideWhitespaceChange={onHideWhitespaceChange}
          onTextContext={onTextContext}
          onSearchResults={onSearchResults}
          query={query}
          searchStep={searchStep}
        />
      )}
    </div>
  )
}

/** 取两版图片再交给 ImageDiffView。放在这里而不是上层，是因为「这是不是图片」
 *  要等 diff 解析出来（isBinary）才知道。 */
export function ImagePane({ repo, file, sha }: { repo: string; file: string; sha: string | null }) {
  const { t } = useTranslation()
  const [data, setData] = useState<ImageDiffData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setData(null)
    setError(null)
    ipc
      .imageDiff(repo, file, sha ?? undefined)
      .then(value => active && setData(value))
      .catch((e: unknown) => active && setError(String(e)))
    return () => {
      active = false
    }
  }, [repo, file, sha])

  if (error) return <Centered>{t("diff.binary")}</Centered>
  if (!data) return <Centered>{t("diff.loading")}</Centered>
  return <ImageDiffView data={data} />
}

function Centered({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-muted-foreground flex flex-1 items-center justify-center text-sm ${className ?? ""}`}>
      {children}
    </div>
  )
}
