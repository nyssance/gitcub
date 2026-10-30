/**
 * App State Store —— Rust 侧 state.json 的前端镜像：仓库列表、当前仓库、侧栏宽度、标签页、主题与语言。
 *
 * 改动经 patch 写进来，变化后 400ms 防抖落盘（拖动侧栏时不至于每帧写文件）。
 * 每次落盘是一个 fiber：新的变化先中断上一个还在等待的，正在写的那次不可中断，
 * 新的一次等它写完才开始，两次写入因此不会交错。
 */
import { Effect, type Fiber } from "effect"
import { create } from "zustand"

import { call, runFork } from "@/features/effect-runtime"
import type { AppState } from "@/models/app-state"

const DEFAULT_STATE: AppState = {
  repositories: [],
  selectedRepository: null,
  repoOwnership: {},
  accountHosts: [],
  oauthClients: {},
  sidebarWidth: 250,
  selectedTab: "changes",
  theme: "system",
  language: ""
}

interface AppStateStore {
  state: AppState | null
  /** 面板的 defaultSize 必须非受控：只在首次载入时取一次侧栏宽度，之后拖动只写 state 用于持久化。 */
  initialWidth: number | null
  load: () => void
  patch: (patch: Partial<AppState>) => void
  update: (update: (state: AppState) => AppState) => void
}

export const useAppStateStore = create<AppStateStore>()(set => ({
  state: null,
  initialWidth: null,
  load: () => {
    runFork(
      call("loadState", ipc => ipc.loadState()).pipe(
        Effect.catch(() => Effect.succeed(DEFAULT_STATE)),
        Effect.tap(state => Effect.sync(() => set({ state, initialWidth: state.sidebarWidth })))
      )
    )
  },
  patch: patch => set(store => (store.state ? { state: { ...store.state, ...patch } } : store)),
  update: update => set(store => (store.state ? { state: update(store.state) } : store))
}))

/** 当前仓库；仓库切走后，还在路上的异步结果据此判断要不要丢掉。 */
export const activeRepository = () => useAppStateStore.getState().state?.selectedRepository ?? null

let saving: Fiber.Fiber<unknown, unknown> | undefined
useAppStateStore.subscribe((store, previous) => {
  const state = store.state
  if (!state || !previous.state || state === previous.state) return
  const prior = saving
  saving = runFork(
    Effect.gen(function* () {
      if (prior) {
        prior.interruptUnsafe()
        yield* Effect.callback<void>(resume => {
          prior.addObserver(() => resume(Effect.void))
        })
      }
      yield* Effect.sleep(400)
      yield* Effect.uninterruptible(
        call("saveState", ipc => ipc.saveState(state)).pipe(
          Effect.catch(error => Effect.sync(() => log.warn("Unable to save application state", error.message)))
        )
      )
    })
  )
})
