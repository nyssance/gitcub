/**
 * Changes Store —— 改动页：选中的文件、多选、每个文件的勾选状态、选中文件的 diff 与语法高亮、逐行追溯的文件。
 *
 * 勾选状态和 Desktop 一样只在内存里、默认全选，提交时才落到 index，打开仓库不会擅自改动用户已暂存的内容。
 * diff 每次重新加载后按 Desktop 的做法刷新可选行，去掉已不在 diff 里的选择。
 */
import { Effect } from "effect"
import { create } from "zustand"

import { forkCancelable, resolve, type Updater } from "@/features/effect-runtime"
import {
  type DiffTokens,
  fileKindOf,
  getDiff,
  getSyntaxTokens,
  initialSelection,
  type LineEndingsChange,
  selectableLines
} from "@/lib/diff"
import type { TerminalOutputListener } from "@/lib/git-execution"
import type { HookProgress } from "@/models/hook-progress"
import type { RepoStatus } from "@/models/repo-status"
import type { IRawDiff } from "@/upstream/models/diff"
import { type DiffSelection, DiffSelectionType } from "@/upstream/models/diff/diff-selection"

export type FileState = { include: DiffSelectionType; selection: DiffSelection | null; diff?: IRawDiff }
export type FileSelection = { repo: string | null; anchor: string | null; paths: string[] }

interface ChangesStore {
  selected: string | null
  fileSelection: FileSelection
  files: Map<string, FileState>
  diff: IRawDiff | null
  tokens: DiffTokens | undefined
  /** git 会改写这个文件的行尾时，diff 上方要说一句 */
  lineEndings: LineEndingsChange | null
  diffError: string | null
  /** 正在逐行追溯的文件；非空时右侧显示 blame 而不是 diff */
  blaming: string | null
  /** Desktop IRepositoryState.hookProgress：提交时钩子的进度，提交开始与结束时清空 */
  hookProgress: HookProgress | null
  /** Desktop IRepositoryState.subscribeToCommitOutput：这次提交有输出后才有，「提交进度」据此显示 */
  subscribeToCommitOutput: TerminalOutputListener | null
  /** Desktop startAmendingRepository：要进入修订的仓库。提交框载入 HEAD 后立即清掉——
   *  只处理一次，提交框重新挂载（切仓库再切回来）时不会再次进入修订 */
  amendRequest: string | null
  requestAmend: (repo: string) => void
  consumeAmendRequest: () => void
  /** Desktop _undoCommit：先切到 Changes 页，提交框再撤销 HEAD 并载回它的提交信息与合著者（git-store undoCommit） */
  undoRequest: string | null
  requestUndo: (repo: string) => void
  consumeUndoRequest: () => void
  reset: () => void
  setSelected: (next: Updater<string | null>) => void
  setFileSelection: (selection: FileSelection) => void
  setFiles: (next: Updater<Map<string, FileState>>) => void
  setBlaming: (file: string | null) => void
  setHookProgress: (hookProgress: HookProgress | null) => void
  setSubscribeToCommitOutput: (subscribeToCommitOutput: TerminalOutputListener | null) => void
  loadDiff: (
    repo: string | null,
    selected: string | null,
    changes: RepoStatus["changes"],
    revision: number
  ) => () => void
  /** 点选文件：选中并立刻开始取 diff，不等界面重新渲染后的 effect；effect 随后以同样的参数调用 loadDiff 时接管这次请求 */
  selectFile: (repo: string | null, path: string | null, changes: RepoStatus["changes"], revision: number) => void
}

/** selectFile 已经发出、还没被 loadDiff 接管的那次请求 */
let early: {
  repo: string | null
  selected: string | null
  changes: RepoStatus["changes"]
  revision: number
  cancel: () => void
} | null = null
/** 当前这次 diff 请求的取消函数；点选时先取消它，旧文件的结果不会落到新选中的文件上 */
let cancelCurrent: () => void = () => {}

export const useChangesStore = create<ChangesStore>()((set, get) => ({
  amendRequest: null,
  requestAmend: repo => set({ amendRequest: repo }),
  consumeAmendRequest: () => set({ amendRequest: null }),
  undoRequest: null,
  requestUndo: repo => set({ undoRequest: repo }),
  consumeUndoRequest: () => set({ undoRequest: null }),
  selected: null,
  fileSelection: { repo: null, anchor: null, paths: [] },
  files: new Map(),
  diff: null,
  tokens: undefined,
  lineEndings: null,
  diffError: null,
  blaming: null,
  hookProgress: null,
  subscribeToCommitOutput: null,
  reset: () => set({ selected: null, files: new Map(), diff: null, tokens: undefined }),
  setSelected: next => set(store => ({ selected: resolve(next, store.selected) })),
  setFileSelection: fileSelection => set({ fileSelection }),
  setFiles: next => set(store => ({ files: resolve(next, store.files) })),
  setBlaming: blaming => set({ blaming }),
  setHookProgress: hookProgress => set({ hookProgress }),
  setSubscribeToCommitOutput: subscribeToCommitOutput => set({ subscribeToCommitOutput }),
  // 文件内容可能变了而 Git 状态没变，所以监听刷新（diffKey）也要重新取
  selectFile: (repo, path, changes, revision) => {
    if (get().selected === path) return
    cancelCurrent()
    early = null
    set({ selected: path })
    const cancel = get().loadDiff(repo, path, changes, revision)
    early = { repo, selected: path, changes, revision, cancel }
  },
  loadDiff: (repo, selected, changes, revision) => {
    const pending = early
    early = null
    if (pending) {
      if (
        pending.repo === repo &&
        pending.selected === selected &&
        pending.changes === changes &&
        pending.revision === revision
      )
        return pending.cancel
      pending.cancel()
    }
    set({ diffError: null })
    if (!repo || !selected) {
      set({ diff: null })
      return () => {}
    }
    const change = changes.find(c => c.path === selected)
    // 子模块不是文件：它的「diff」由 SubmoduleView 自己去取
    if (change?.submodule) {
      set({ diff: null, tokens: undefined })
      return () => {}
    }
    set({ diff: null, lineEndings: null, tokens: undefined })
    cancelCurrent = forkCancelable(
      Effect.all(
        [
          // 语法高亮独立于 diff：失败或太大就只是没颜色
          Effect.tryPromise(() => getSyntaxTokens(repo, selected)).pipe(
            Effect.match({ onSuccess: tokens => set({ tokens }), onFailure: () => {} })
          ),
          Effect.tryPromise(() =>
            getDiff(repo, selected, fileKindOf(change ?? { kind: "unstaged", change: "modified" }))
          ).pipe(
            Effect.match({
              onSuccess: ({ diff, lineEndings }) =>
                set(store => {
                  const current = store.files.get(selected)
                  const selection = current?.selection
                    ? current.selection.withSelectableLines(selectableLines(diff))
                    : current?.include === DiffSelectionType.None
                      ? initialSelection(diff).withSelectNone()
                      : initialSelection(diff)
                  return {
                    diff,
                    lineEndings,
                    files: new Map(store.files).set(selected, {
                      include: selection.getSelectionType(),
                      selection,
                      diff
                    })
                  }
                }),
              onFailure: error => set({ diffError: String(error.cause ?? error) })
            })
          )
        ],
        { concurrency: 2 }
      )
    )
    return cancelCurrent
  }
}))
