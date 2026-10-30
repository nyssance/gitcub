import { type ReactNode, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { ipc } from "@/lib/ipc"
import type { AppState } from "@/models/app-state"
import { Button } from "@/ui/base/button"

/** First-run only: Application mounts this gate only while the welcome flow is active. */
export function DesktopImportWelcome({
  children,
  onImported
}: {
  children: ReactNode
  onImported: (state: AppState) => void
}) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<"loading" | "offer" | "done" | "error">("loading")
  const [hasData, setHasData] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  useEffect(() => {
    let active = true
    void ipc
      .detectDesktopImport()
      .then(result => {
        if (!active) return
        setHasData(result.hasData)
        setPhase(result.handled || !result.installed ? "done" : "offer")
      })
      .catch(e => {
        if (active) {
          setError(String(e))
          setPhase("error")
        }
      })
    return () => {
      active = false
    }
  }, [])
  const finish = async (shouldImport: boolean) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      const state = await ipc.finishDesktopImport(shouldImport)
      onImported(state)
      setPhase("done")
    } catch (e) {
      setError(String(e))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  if (phase === "done") return children
  return (
    <section
      className="bg-background flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6"
      aria-label={t("welcome.desktopImportTitle")}>
      <div className="flex w-full max-w-lg flex-col gap-6 py-8">
        {phase === "loading" ? (
          <p role="status">{t("welcome.desktopDetecting")}</p>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">{t("welcome.desktopImportTitle")}</h1>
            <p className="text-muted-foreground text-sm">
              {t(hasData ? "welcome.desktopImportDescription" : "welcome.desktopNoData")}
            </p>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button disabled={busy || !hasData} onClick={() => void finish(true)}>
                {t(busy ? "prefs.desktopImporting" : "prefs.desktopImportAction")}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void finish(false)}>
                {t("welcome.desktopSkip")}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
