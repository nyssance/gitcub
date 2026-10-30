import { Channel } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon, RefreshCwIcon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { ipc } from "@/lib/ipc"
import { getZoomFactor } from "@/lib/menu/native-menu"
import type { BrowserAction, BrowserState } from "@/models/browser"
import { Alert, AlertDescription } from "@/ui/base/alert"
import { Button } from "@/ui/base/button"

const TRENDING_URL = "https://github.com/trending"
let updates = Promise.resolve()
const enqueue = <T,>(operation: () => Promise<T>) => {
  const next = updates.then(operation)
  updates = next.then(
    () => {},
    () => {}
  )
  return next
}

/** Native child webview: GitHub disallows iframe embedding. The page receives no app permissions. */
export function Trending({ active }: { active: boolean }) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const sync = useRef<(reload?: boolean) => void>(() => {})
  const control = useRef<(action: BrowserAction) => void>(() => {})
  const [browser, setBrowser] = useState<BrowserState>({
    url: TRENDING_URL,
    canGoBack: false,
    canGoForward: false
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    const element = host.current
    if (!element) return
    const session = crypto.randomUUID()
    let disposed = false
    let lastFrame = ""
    let timeout: ReturnType<typeof setTimeout> | undefined
    let failed = false
    let requested = false
    const beginLoad = () => {
      clearTimeout(timeout)
      setLoading(true)
      timeout = setTimeout(() => {
        failed = true
        setLoading(false)
        setError(t("trending.webLoadFailed"))
        sync.current()
      }, 30000)
    }
    const onLoad = (event: string) => {
      if (disposed) return
      if (event === "updated") {
        control.current("state")
        return
      }
      clearTimeout(timeout)
      if (event === "finished") {
        failed = false
        setLoading(false)
        setError(null)
        sync.current()
      } else {
        beginLoad()
      }
      control.current("state")
    }
    control.current = action => {
      if (disposed || !requested) return
      if (action === "back" || action === "forward") {
        failed = false
        setError(null)
        sync.current()
      }
      if (action === "stop") {
        clearTimeout(timeout)
        setLoading(false)
      }
      void enqueue(() => ipc.controlTrendingWebview(session, action))
        .then(state => {
          if (!disposed) {
            setBrowser(state)
            if (action === "stop") {
              clearTimeout(timeout)
              setLoading(false)
            }
          }
        })
        .catch(reason => {
          if (!disposed) {
            clearTimeout(timeout)
            setLoading(false)
            setError(String(reason))
          }
        })
    }
    const update = (reload = false) => {
      if (disposed) return
      if (reload) {
        failed = false
        setError(null)
      }
      const bounds = element.getBoundingClientRect()
      const zoom = getZoomFactor()
      const overlay = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')].some(
        el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"
      )
      const frame = {
        x: Math.max(0, bounds.x * zoom),
        y: Math.max(0, bounds.y * zoom),
        width: Math.max(1, bounds.width * zoom),
        height: Math.max(1, bounds.height * zoom),
        visible: activeRef.current && !overlay && !failed && bounds.width > 0 && bounds.height > 0
      }
      const key = JSON.stringify(frame)
      if (!reload && key === lastFrame) return
      lastFrame = key
      // WKWebView's Started callback can wait for a network response. Start the
      // deadline before creating the view so a stalled connection also recovers.
      // A Channel is owned by its Rust receiver. Passing it again would create
      // another receiver whose drop unregisters the original JS callback.
      const channel = frame.visible && !requested ? new Channel<string>(onLoad) : undefined
      if (reload || channel) {
        requested = true
        beginLoad()
      }
      void enqueue(() => ipc.syncTrendingWebview(session, frame, reload, channel)).catch(reason => {
        if (!disposed) {
          if (channel) requested = false
          clearTimeout(timeout)
          setLoading(false)
          setError(String(reason))
        }
      })
    }
    sync.current = update
    const resize = new ResizeObserver(() => update())
    resize.observe(element)
    const overlays = new MutationObserver(() => update())
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-open", "data-closed", "aria-hidden", "hidden"]
    })
    window.addEventListener("resize", updateSize)
    const unlistenZoom = listen("zoom-factor-changed", () => update())
    function updateSize() {
      update()
    }
    update()
    return () => {
      disposed = true
      clearTimeout(timeout)
      resize.disconnect()
      overlays.disconnect()
      window.removeEventListener("resize", updateSize)
      void unlistenZoom.then(unlisten => unlisten())
      sync.current = () => {}
      control.current = () => {}
      void enqueue(() => ipc.syncTrendingWebview(session, null, false)).catch(console.error)
    }
  }, [t])

  useEffect(() => sync.current(), [active])

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="GitHub Trending">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("trending.back")}
          title={t("trending.back")}
          disabled={!browser.canGoBack}
          onClick={() => control.current("back")}>
          <ArrowLeftIcon className="rtl:rotate-180" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("trending.forward")}
          title={t("trending.forward")}
          disabled={!browser.canGoForward}
          onClick={() => control.current("forward")}>
          <ArrowRightIcon className="rtl:rotate-180" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={loading ? t("trending.stop") : t("discover.refresh")}
          title={loading ? t("trending.stop") : t("discover.refresh")}
          onClick={() => (loading ? control.current("stop") : sync.current(true))}>
          {loading ? <XIcon /> : <RefreshCwIcon />}
        </Button>
        <span className="min-w-0 flex-1 truncate px-2 text-sm" title={browser.url}>
          {browser.url}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("rail.openInBrowser")}
          title={t("rail.openInBrowser")}
          onClick={() => control.current("openExternal")}>
          <ExternalLinkIcon />
        </Button>
      </header>
      <div ref={host} className="relative min-h-0 flex-1" data-trending-webview>
        {error && (
          <Alert className="m-4 w-auto">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </section>
  )
}
