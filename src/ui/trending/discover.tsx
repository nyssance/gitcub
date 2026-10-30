import { RefreshCwIcon } from "lucide-react"
import { useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"

import { type Route, routes } from "@/lib/navigate"
import { Button } from "@/ui/base/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/base/tabs"

import { RemoteRepoList } from "./stars"

/** Hosted repositories and stars share the same compact toolbar. Trending lives on the left board. */

const TABS = [
  { kind: "mine", uri: routes.mine() },
  { kind: "stars", uri: routes.stars() }
] as const

interface Props {
  route: Route
  onNavigate: (uri: string) => void
  hosts: string[]
  cloned: Map<string, string>
  onOpen: (path: string) => void
  onCloned: (path: string) => void
}

export function Discover({ route, onNavigate, hosts, cloned, onOpen, onCloned }: Props) {
  const { t } = useTranslation()
  const reload = useRef<(() => void) | null>(null)
  const register = useCallback((fn: () => void) => {
    reload.current = fn
  }, [])

  return (
    <Tabs
      value={route.kind}
      onValueChange={value => {
        const tab = TABS.find(tab => tab.kind === value)
        if (tab) onNavigate(tab.uri)
      }}
      className="h-full min-h-0 gap-0">
      <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b px-4 py-2">
        <TabsList className="shrink-0" aria-label={t("rail.discover")}>
          {TABS.map(tab => (
            <TabsTrigger key={tab.kind} value={tab.kind}>
              {t(`discover.${tab.kind}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="flex-1" />

        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("discover.refresh")}
          title={t("discover.refresh")}
          onClick={() => reload.current?.()}>
          <RefreshCwIcon />
        </Button>
      </div>

      {(["mine", "stars"] as const).map(kind => (
        <TabsContent key={kind} value={kind} className="min-h-0">
          {route.kind === kind && (
            <RemoteRepoList
              kind={kind}
              hosts={hosts}
              cloned={cloned}
              onOpen={onOpen}
              onCloned={onCloned}
              onReload={register}
            />
          )}
        </TabsContent>
      ))}
    </Tabs>
  )
}
