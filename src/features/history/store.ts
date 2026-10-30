/**
 * History Store —— 历史页：提交图（按页追加）、没有上游时的本地提交、选中提交的文件与 diff、文件历史、分支对比结果。
 *
 * 每类请求一个任务组。从头加载、换提交、换文件时整组中断，还在路上的翻页结果不会追加到新列表后面；
 * 中断时把对应的「加载中」复位，切回来能重新发起。翻页同 Desktop loadNextCommitBatch：有请求在飞就不再发，
 * 失败不重试，错误显示在错误槽，刷新或切回来从头加载。
 */
import { Effect } from "effect"
import { create } from "zustand"

import { call, createTaskGroup, forkCancelable, resolve, type Updater } from "@/features/effect-runtime"
import { useRepositoryStore } from "@/features/repository/store"
import { type DiffTokens, getCommitSyntaxTokens } from "@/lib/diff"
import { FILE_HISTORY_BATCH, GRAPH_BATCH } from "@/lib/ipc"
import type { LocalCommits } from "@/lib/unpushed-commits"
import type { CommitFile, CommitInfo, Comparison, GraphCursor, GraphRow } from "@/models/history"
import { DiffParser } from "@/upstream/lib/diff-parser"
import type { IRawDiff } from "@/upstream/models/diff"

/** 文件历史里选中的那个文件在某次提交的文件列表里叫什么：改名那一次按旧名也能对上 */
export function matchCommitFile(files: CommitFile[], path: string): string | null {
  return files.find(file => file.path === path || file.oldPath === path)?.path ?? null
}

interface HistoryStore {
  graphRows: GraphRow[]
  graphCursor: GraphCursor | null
  graphDone: boolean
  graphLoading: boolean
  /** 没有上游时 Desktop 的 localCommitSHAs（`HEAD --not --remotes`）；有上游或没远端时为 null */
  localCommits: LocalCommits | null
  commitSha: string | null
  commitFiles: CommitFile[]
  commitFile: string | null
  commitDiff: IRawDiff | null
  commitTokens: DiffTokens | undefined
  /** 文件历史模式：只列改过这个文件的提交 */
  historyFile: string | null
  fileCommits: CommitInfo[]
  fileHistoryLoading: boolean
  fileHistoryError: string | null
  fileHistoryMore: boolean
  fileHistoryLoadingMore: boolean
  /** 正在对比时的结果；选中的提交可能来自对方那条分支 */
  compared: Comparison | null
  reset: () => void
  loadGraph: (repo: string) => () => void
  loadMoreGraph: (repo: string) => void
  loadLocalCommits: (repo: string | null, needed: boolean) => void
  loadFileHistory: (repo: string | null, file: string | null) => void
  loadMoreFileHistory: (repo: string) => void
  loadCommitFiles: (repo: string | null, sha: string | null) => () => void
  loadCommitDiff: (repo: string | null, sha: string | null, file: string | null, oldPath: string | null) => () => void
  selectCommit: (sha: string) => void
  setCommitSha: (sha: string | null) => void
  setCommitFile: (file: string | null) => void
  setHistoryFile: (file: string | null) => void
  setCompared: (next: Updater<Comparison | null>) => void
}

const graph = createTaskGroup()
const local = createTaskGroup()
const fileHistory = createTaskGroup()
/** 上一页返回的续走游标，翻页时传回去；换会话时清掉（后端核对不上也会从头走） */
let fileHistoryCursor: string | null = null
/** 从文件历史里选提交时，文件列表回来后优先选这个文件而不是第一个 */
let preferredFile: string | null = null

const reportError = (message: string) => useRepositoryStore.getState().setError(message)

export const useHistoryStore = create<HistoryStore>()((set, get) => ({
  graphRows: [],
  graphCursor: null,
  graphDone: false,
  graphLoading: false,
  localCommits: null,
  commitSha: null,
  commitFiles: [],
  commitFile: null,
  commitDiff: null,
  commitTokens: undefined,
  historyFile: null,
  fileCommits: [],
  fileHistoryLoading: false,
  fileHistoryError: null,
  fileHistoryMore: false,
  fileHistoryLoadingMore: false,
  compared: null,
  reset: () => {
    graph.interrupt()
    preferredFile = null
    set({
      compared: null,
      graphRows: [],
      graphCursor: null,
      graphDone: false,
      graphLoading: false,
      commitSha: null,
      commitFiles: [],
      commitFile: null,
      commitDiff: null,
      commitTokens: undefined,
      historyFile: null
    })
  },
  // 提交图自带提交信息，一次请求就够。默认选中 HEAD 历史的第一条（同 Desktop）；别的分支或贮藏可能排在它前面
  loadGraph: repo => {
    graph.interrupt()
    set({ graphLoading: true })
    graph.fork(
      call("graph", ipc => ipc.graph(repo, GRAPH_BATCH, 0, null)).pipe(
        Effect.match({
          onSuccess: page =>
            set(store => ({
              graphRows: page.rows,
              graphCursor: page.cursor,
              graphDone: page.done,
              graphLoading: false,
              commitSha: store.commitSha ?? (page.rows.find(row => row.onHead) ?? page.rows[0])?.commit.sha ?? null
            })),
          onFailure: error => {
            set({ graphLoading: false })
            reportError(error.message)
          }
        }),
        Effect.onInterrupt(() => Effect.sync(() => set({ graphLoading: false })))
      )
    )
    return () => graph.interrupt()
  },
  // skip 是已有行数，cursor 让泳道和颜色接上；Desktop _loadNextCommitBatch 翻历史时顺带把本地提交也翻一页
  loadMoreGraph: repo => {
    const { graphLoading, graphDone, graphCursor, graphRows, localCommits } = get()
    if (graphLoading || graphDone || !graphCursor) return
    set({ graphLoading: true })
    if (localCommits && !localCommits.done) {
      const skip = localCommits.shas.size
      local.fork(
        call("localCommits", ipc => ipc.localCommits(repo, GRAPH_BATCH, skip)).pipe(
          Effect.match({
            onSuccess: shas =>
              set(store => ({
                localCommits: store.localCommits
                  ? { shas: new Set([...store.localCommits.shas, ...shas]), done: shas.length < GRAPH_BATCH }
                  : store.localCommits
              })),
            onFailure: error => {
              set(store => ({ localCommits: store.localCommits ? { ...store.localCommits, done: true } : null }))
              reportError(error.message)
            }
          })
        )
      )
    }
    graph.fork(
      call("graph", ipc => ipc.graph(repo, GRAPH_BATCH, graphRows.length, graphCursor)).pipe(
        Effect.match({
          onSuccess: page =>
            set(store => ({
              graphRows: [...store.graphRows, ...page.rows],
              graphCursor: page.cursor,
              graphDone: page.done,
              graphLoading: false
            })),
          onFailure: error => {
            set({ graphDone: true, graphLoading: false })
            reportError(error.message)
          }
        }),
        Effect.onInterrupt(() => Effect.sync(() => set({ graphLoading: false })))
      )
    )
  },
  // 取不到就不标（Desktop performFailableOperation 同样只记错不抛），错误显示在错误槽
  loadLocalCommits: (repo, needed) => {
    local.interrupt()
    if (!repo || !needed) {
      set({ localCommits: null })
      return
    }
    local.fork(
      call("localCommits", ipc => ipc.localCommits(repo, GRAPH_BATCH, 0)).pipe(
        Effect.match({
          onSuccess: shas => set({ localCommits: { shas: new Set(shas), done: shas.length < GRAPH_BATCH } }),
          onFailure: error => {
            set({ localCommits: null })
            reportError(error.message)
          }
        })
      )
    )
  },
  loadFileHistory: (repo, file) => {
    fileHistory.interrupt()
    fileHistoryCursor = null
    set({ fileHistoryMore: false, fileHistoryLoadingMore: false })
    if (!repo || !file) {
      set({ fileCommits: [], fileHistoryError: null, fileHistoryLoading: false })
      return
    }
    set({ fileHistoryLoading: true })
    fileHistory.fork(
      call("fileHistory", ipc => ipc.fileHistory(repo, file, 0, FILE_HISTORY_BATCH)).pipe(
        Effect.match({
          onSuccess: page => {
            fileHistoryCursor = page.cursor
            set({ fileCommits: page.commits, fileHistoryMore: page.hasMore, fileHistoryError: null })
          },
          onFailure: error => set({ fileCommits: [], fileHistoryError: error.message })
        }),
        Effect.ensuring(Effect.sync(() => set({ fileHistoryLoading: false })))
      )
    )
  },
  loadMoreFileHistory: repo => {
    const { historyFile, fileHistoryLoading, fileHistoryLoadingMore, fileHistoryMore, fileCommits } = get()
    if (!historyFile || fileHistoryLoading || fileHistoryLoadingMore || !fileHistoryMore) return
    set({ fileHistoryLoadingMore: true })
    const cursor = fileHistoryCursor
    fileHistory.fork(
      call("fileHistory", ipc =>
        ipc.fileHistory(repo, historyFile, fileCommits.length, FILE_HISTORY_BATCH, cursor)
      ).pipe(
        Effect.match({
          onSuccess: page => {
            fileHistoryCursor = page.cursor
            set(store => ({ fileCommits: [...store.fileCommits, ...page.commits], fileHistoryMore: page.hasMore }))
          },
          onFailure: error => {
            fileHistoryCursor = null
            set({ fileHistoryMore: false, fileHistoryError: error.message })
          }
        }),
        Effect.ensuring(Effect.sync(() => set({ fileHistoryLoadingMore: false })))
      )
    )
  },
  // 从文件历史里选的提交：选中那个文件（改名那一次按旧名也能对上），对不上才退回第一个
  loadCommitFiles: (repo, sha) => {
    if (!repo || !sha) {
      set({ commitFiles: [] })
      return () => {}
    }
    return forkCancelable(
      call("commitFiles", ipc => ipc.commitFiles(repo, sha)).pipe(
        Effect.match({
          onSuccess: files => {
            const wanted = preferredFile
            preferredFile = null
            set({
              commitFiles: files,
              commitFile: (wanted && matchCommitFile(files, wanted)) ?? files[0]?.path ?? null
            })
          },
          onFailure: error => reportError(error.message)
        })
      )
    )
  },
  // 语法高亮独立于 diff：失败或太大就只是没颜色，不挡住 diff
  loadCommitDiff: (repo, sha, file, oldPath) => {
    if (!repo || !sha || !file) {
      set({ commitDiff: null })
      return () => {}
    }
    set({ commitTokens: undefined })
    return forkCancelable(
      Effect.all(
        [
          Effect.tryPromise(() => getCommitSyntaxTokens(repo, sha, file)).pipe(
            Effect.match({ onSuccess: commitTokens => set({ commitTokens }), onFailure: () => {} })
          ),
          call("commitFileDiff", ipc => ipc.commitFileDiff(repo, sha, file, oldPath)).pipe(
            Effect.match({
              onSuccess: text => set({ commitDiff: new DiffParser().parse(text) }),
              onFailure: error => reportError(error.message)
            })
          )
        ],
        { concurrency: 2 }
      )
    )
  },
  /** 文件历史里选提交：和普通历史一样选中，另外把这个文件也选上；同一个提交不再拉文件列表，直接在已有的里挑 */
  selectCommit: sha => {
    const { historyFile, commitSha, commitFiles, commitFile } = get()
    if (historyFile) {
      if (sha === commitSha) set({ commitFile: matchCommitFile(commitFiles, historyFile) ?? commitFile })
      else preferredFile = historyFile
    }
    set({ commitSha: sha })
  },
  setCommitSha: commitSha => set({ commitSha }),
  setCommitFile: commitFile => set({ commitFile }),
  setHistoryFile: historyFile => set({ historyFile }),
  setCompared: next => set(store => ({ compared: resolve(next, store.compared) }))
}))
