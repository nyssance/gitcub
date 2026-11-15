/**
 * Workspace Store —— 右侧显示什么：画布页（-1 屏趋势 / 工作屏）、路由、改动页的贮藏与筛选开关、操作完成提示。
 * 路由只认这一份，见 lib/navigate.ts。
 */
import { create } from "zustand"

import { resolve, type Updater } from "@/features/effect-runtime"
import type { Route } from "@/lib/navigate"

interface WorkspaceStore {
  canvasPage: number
  route: Route
  stashesVisible: boolean
  filterVisible: boolean
  banner: string | null
  setCanvasPage: (page: number) => void
  setRoute: (route: Route) => void
  setStashesVisible: (visible: boolean) => void
  setFilterVisible: (next: Updater<boolean>) => void
  setBanner: (banner: string | null) => void
}

export const useWorkspaceStore = create<WorkspaceStore>()(set => ({
  canvasPage: 1,
  route: { kind: "repo" },
  stashesVisible: true,
  filterVisible: true,
  banner: null,
  setCanvasPage: canvasPage => set({ canvasPage }),
  setRoute: route => set({ route }),
  setStashesVisible: stashesVisible => set({ stashesVisible }),
  setFilterVisible: next => set(store => ({ filterVisible: resolve(next, store.filterVisible) })),
  setBanner: banner => set({ banner })
}))
