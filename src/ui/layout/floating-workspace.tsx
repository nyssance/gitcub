import { connectDesktopOverview } from "@alwith/module-desktop-shell/overview"
import "@alwith/module-desktop-shell/overview.css"
import { openUrl } from "@tauri-apps/plugin-opener"
import "@nyssance/atlas/styles.css"
import { connectTrackpad } from "@nyssance/atlas/dom"
import { desktopDefaults } from "@nyssance/atlas/layout"
import { useAtlas } from "@nyssance/atlas/react"
import { tauriTrackpad } from "@nyssance/atlas/tauri"
import { type ReactNode, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

import { Trending } from "@/ui/trending/trending"

/** Business regions only; Atlas owns input, snapping and controller lifecycle. */
export function FloatingWorkspace({
  page,
  onPageChange,
  navigation,
  trackpadEnabled = false,
  children
}: {
  page: number
  onPageChange: (page: number) => void
  navigation: ReactNode
  trackpadEnabled?: boolean
  children: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const onChange = useRef(onPageChange)
  onChange.current = onPageChange
  const {
    ref: viewport,
    atlas,
    state
  } = useAtlas({
    initialRegion: page === 0 ? "trending" : "workspace",
    flickMinIndex: 1,
    direction: i18n.dir(),
    trackpadEnabled,
    // 没有分页圆点和状态栏，底部不留 32px 的页脚：与左右一样是标准 gutter 合成的外沿（4 + 4）
    insetBottom: desktopDefaults.gutter * 2,
    pagination: false,
    overview: { label: t("canvas.overview") }
  })
  const settled = !state.moving
  useEffect(() => (atlas ? connectDesktopOverview(atlas, { openLink: openUrl }) : undefined), [atlas])
  useEffect(() => {
    const region = page === 0 ? "trending" : "workspace"
    if (atlas && atlas.getState().activeRegion !== region) atlas.goTo(region)
  }, [atlas, page])
  useEffect(() => {
    if (state.activeRegion) onChange.current(state.activeRegion === "trending" ? 0 : 1)
  }, [state.activeRegion])
  useEffect(() => {
    if (!atlas) return
    return connectTrackpad(atlas, tauriTrackpad(), error => console.error("Trackpad unavailable", error))
  }, [atlas])

  return (
    <div className="bg-muted/40 flex min-h-0 min-w-0 flex-1 flex-col" data-floating-workspace data-page={page}>
      {/* Atlas 的标准上边距（32px，与 ALwith Desktop 相同）就是标题栏高度；视口自身可拖窗口，
          Tauri 只在按下的正是这个元素时拖动，面板里的点击不受影响 */}
      <div
        ref={viewport}
        className="min-h-0 flex-1 overflow-hidden"
        data-tauri-drag-region
        data-canvas-viewport
        data-atlas
        data-atlas-layout="navigation"
        role="group"
        aria-label={t("canvas.label")}
        tabIndex={0}>
        <div className="flex h-full touch-pan-y will-change-transform" data-canvas-track data-atlas-track>
          {/* ALwith's 244px peek keeps all 240px of navigation visible on the
              right of screen -1. The extra 4px prevents Embla grouping it into
              that screen; navigation and workspace remain the next snap. */}
          <section
            className="h-full min-w-0"
            data-atlas-region="trending"
            data-atlas-leading
            aria-label={t("discover.discover")}
            aria-hidden={page !== 0}
            inert={page !== 0}>
            <div
              className="bg-background flex h-full min-h-0 flex-col overflow-clip rounded-xl border"
              data-floating-board="trending">
              <Trending active={page === 0 && settled} />
            </div>
          </section>
          <nav
            className="h-full min-h-0 overflow-hidden"
            aria-label={t("rail.repositories")}
            data-canvas-navigation
            data-atlas-navigation>
            <div data-atlas-navigation-surface>{navigation}</div>
          </nav>
          <section
            className="h-full min-w-0"
            role="group"
            data-atlas-region="workspace"
            aria-label={t("canvas.workspace")}
            aria-hidden={page !== 1}
            inert={page !== 1}>
            <div
              className="bg-background flex h-full min-h-0 overflow-clip rounded-xl border"
              data-floating-board="workspace">
              {children}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
