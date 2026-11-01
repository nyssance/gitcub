import { open as pickDirectory } from "@tauri-apps/plugin-dialog"
import { DownloadIcon } from "lucide-react"
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { ipc } from "@/lib/ipc"
import { keepLastSuccessful } from "@/lib/remote-repos"
import type { RemoteRepo } from "@/models/app-state"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ItemGroup, ItemSeparator } from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { InlineError } from "@/ui/shared/inline-error"

import { RepositoryItem } from "./repository-item"

/** 你的仓库 / 你 star 过的仓库。
 *
 * 两者的行长一样，区别只在取哪个接口，所以共用一个组件：
 *   mine   GET /user/repos（GitLab：/projects?membership=true）
 *   stars  GET /user/starred（GitLab：/projects?starred=true）
 *
 * 已经克隆到本地的用不着再显示「克隆」，直接打开。 */

interface Props {
  kind: "mine" | "stars"
  /** 要问哪些实例。每个实例分别请求，慢的那个不拖住别人 */
  hosts: string[]
  /** 本地已有的仓库，键是 `host/owner/name` */
  cloned: Map<string, string>
  onOpen: (path: string) => void
  onCloned: (path: string) => void
  /** 把「重新拉一次」交给页面壳上的刷新按钮 */
  onReload: (fn: () => void) => void
}

export function RemoteRepoList({ kind, hosts, cloned, onOpen, onCloned, onReload }: Props) {
  const { t } = useTranslation()
  const [list, setList] = useState<RemoteRepo[]>([])
  const [busy, setBusy] = useState(true)
  const [cloning, setCloning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signedOut, setSignedOut] = useState(false)
  const request = useRef(0)
  const shown = useRef<RemoteRepo[]>([])
  useEffect(() => {
    shown.current = list
  }, [list])

  const load = useCallback(
    (refresh = false) => {
      const id = ++request.current
      const previous = shown.current
      setBusy(true)
      setError(null)
      if (!refresh) setList([])
      // 按 url 去重后整体替换，不要往旧列表上追加：
      // 开发模式下 effect 会跑两遍，追加就会出现重复的 key（实测 React 报
      // “Encountered two children with the same key”）。
      const seen = new Map<string, RemoteRepo>()
      const errors: string[] = []
      let successful = 0
      const pending = hosts.map(host =>
        (kind === "mine" ? ipc.myRepos(host, refresh) : ipc.myStars(host, refresh))
          .then(repos => {
            if (id !== request.current) return
            successful++
            for (const r of repos) seen.set(r.url, r)
            setList([...seen.values()])
          })
          .catch(error => {
            if (id !== request.current) return
            const message = String(error)
            if (!message.includes("还没登录") && !message.includes("已登出")) {
              errors.push(`${host}: ${message}`)
              setError(errors.join("\n"))
              // 读取失败不能变成「这个实例没有仓库」：它上次成功的行留着，和错误一起显示。
              setList([...keepLastSuccessful(seen, previous, host).values()])
            }
          })
      )
      return Promise.all(pending).then(() => {
        if (id !== request.current) return
        setList([...seen.values()])
        setSignedOut(successful === 0 && errors.length === 0)
        setBusy(false)
      })
    },
    [kind, hosts]
  )

  useEffect(() => {
    void load()
    const pending = request
    return () => {
      pending.current++
    }
  }, [load])
  useEffect(() => onReload(() => void load(true)), [onReload, load])

  const clone = async (repo: RemoteRepo) => {
    const dir = await pickDirectory({ directory: true, multiple: false })
    if (typeof dir !== "string") return
    const target = `${dir}/${repo.name}`
    setCloning(repo.url)
    setError(null)
    try {
      await ipc.cloneRepo(repo.url, target)
      onCloned(target)
    } catch (e) {
      setError(String(e))
    } finally {
      setCloning(null)
    }
  }

  const sorted = [...list].toSorted((a, b) => b.stars - a.stars)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && <InlineError error={error} />}
      <ScrollArea className="min-h-0 flex-1">
        {busy && list.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : sorted.length === 0 && error ? null : sorted.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{signedOut ? t("rail.signedOutTitle") : t(`discover.${kind}Empty`)}</EmptyTitle>
              {signedOut && <EmptyDescription>{t("discover.signInHint")}</EmptyDescription>}
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-0! px-1">
            {sorted.map((r, index) => {
              const local = cloned.get(`${r.host}/${r.owner}/${r.name}`)
              return (
                <Fragment key={r.url}>
                  {index > 0 && <ItemSeparator aria-hidden="true" className="my-0" />}
                  <RepositoryItem {...r} url={`https://${r.host}/${r.owner}/${r.name}`}>
                    {local ? (
                      <Button size="sm" variant="secondary" onClick={() => onOpen(local)}>
                        {t("discover.open")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={cloning !== null}
                        onClick={() => void clone(r)}
                        className="shrink-0">
                        {cloning === r.url ? <Spinner /> : <DownloadIcon data-icon="inline-start" />}
                        {t("trending.clone")}
                      </Button>
                    )}
                  </RepositoryItem>
                </Fragment>
              )
            })}
          </ItemGroup>
        )}
      </ScrollArea>
    </div>
  )
}
