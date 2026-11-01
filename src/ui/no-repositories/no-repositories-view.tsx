import { GitBranchIcon, LightBulbIcon, PlusIcon, RepoIcon } from "@primer/octicons-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

interface Props {
  repositories: string[]
  onSelect: (repo: string) => void
  onAdd: () => void
  onClone: (url: string) => Promise<void>
}

const nameOf = (p: string) => p.split("/").findLast(Boolean) ?? p

/** 没有选中仓库时的整屏欢迎页。
 *
 * Desktop 在这个状态下 `renderToolbar()` 直接返回 null——不显示工具栏，
 * 也没有左右分栏，整个窗口就是这一页。左边是仓库列表，右边是操作按钮。 */
export function NoRepositoriesView({ repositories, onSelect, onAdd, onClone }: Props) {
  const { t } = useTranslation()
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)

  const clone = async () => {
    if (!url.trim()) return
    setBusy(true)
    try {
      await onClone(url.trim())
      setUrl("")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={t("noRepos.title")} className="flex h-full flex-col items-center overflow-auto px-8 py-14">
      <header className="flex flex-col items-center gap-1.5 text-center">
        <h1 className="text-2xl font-semibold">{t("noRepos.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("noRepos.subtitle")}</p>
      </header>

      <div className="mt-10 flex w-full max-w-3xl flex-1 gap-8">
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-muted-foreground mb-2 text-xs font-medium">{t("noRepos.recent")}</p>
          <Separator />
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {repositories.length === 0 ? (
              <p className="text-muted-foreground px-1 py-6 text-xs">{t("noRepos.none")}</p>
            ) : (
              repositories.map(r => (
                <Item
                  key={r}
                  size="sm"
                  onClick={() => onSelect(r)}
                  className={cn("hover:bg-accent cursor-default rounded-md px-2 py-1.5")}>
                  <ItemMedia variant="icon">
                    <RepoIcon size={16} className="text-muted-foreground" />
                  </ItemMedia>
                  <ItemContent className="min-w-0 gap-0">
                    <ItemTitle className="truncate text-xs">{nameOf(r)}</ItemTitle>
                    <ItemDescription className="truncate text-[11px]">{r}</ItemDescription>
                  </ItemContent>
                </Item>
              ))
            )}
          </div>
        </div>

        <div className="flex w-72 shrink-0 flex-col gap-3">
          <Button variant="outline" className="justify-start" onClick={onAdd}>
            <PlusIcon size={16} />
            {t("noRepos.addLocal")}
          </Button>
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <p className="text-xs font-medium">{t("noRepos.clone")}</p>
            <Input
              value={url}
              onChange={e => setUrl(e.currentTarget.value)}
              onKeyDown={e => e.key === "Enter" && void clone()}
              placeholder="https://github.com/owner/repo.git"
              className="h-8 font-mono text-xs"
            />
            <Button size="sm" disabled={!url.trim() || busy} onClick={() => void clone()}>
              {busy && <Spinner data-icon="inline-start" />}
              <GitBranchIcon size={16} />
              {t("noRepos.cloneAction")}
            </Button>
            <p className="text-muted-foreground text-[11px]">{t("noRepos.cloneHint")}</p>
          </div>

          <div className="bg-muted/60 text-muted-foreground mt-2 flex gap-2 rounded-md p-3 text-[11px]">
            <LightBulbIcon size={16} className="mt-px shrink-0" />
            <p>
              <strong className="text-foreground font-semibold">{t("noRepos.tipLabel")}</strong> {t("noRepos.tip")}
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
