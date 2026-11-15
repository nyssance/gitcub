/**
 * Repository Indicators Store —— 左栏每个仓库的 ↑↓ 与未提交改动圆点。
 *
 * 数据来自移植的 AppStore：Desktop 的 RepositoryIndicatorUpdater 每 15 分钟逐个刷新非当前仓库的
 * status，并按 shouldBackgroundFetch 后台 fetch（app-store.ts refreshIndicatorForRepository）。
 * AppStore 按仓库 id 记，左栏按路径列，这里换成路径。当前仓库不在其中，左栏直接用工作区状态。
 */
import equal from "deep-equal"
import { create } from "zustand"

import { getDesktopRuntime } from "@/lib/desktop-runtime"
import type { ILocalRepositoryState } from "@/models/repository"

interface RepositoryIndicatorsStore {
  byPath: Record<string, ILocalRepositoryState>
  /** 订阅 AppStore 的更新；返回的函数取消订阅。 */
  bind: () => () => void
}

export const useRepositoryIndicatorsStore = create<RepositoryIndicatorsStore>((set, get) => ({
  byPath: {},
  bind: () => {
    const { appStore } = getDesktopRuntime()
    const sync = () => {
      const { repositories, localRepositoryStateLookup } = appStore.getState()
      const byPath: Record<string, ILocalRepositoryState> = {}
      for (const repository of repositories) {
        const state = localRepositoryStateLookup.get(repository.id)
        if (state) byPath[repository.path] = state
      }
      if (!equal(byPath, get().byPath)) set({ byPath })
    }
    sync()
    const subscription = appStore.onDidUpdate(sync)
    return () => subscription.dispose()
  }
}))
