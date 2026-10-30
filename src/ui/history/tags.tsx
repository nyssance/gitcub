import { confirm } from "@tauri-apps/plugin-dialog"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { ipc } from "@/lib/ipc"

import { Button } from "../base/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../base/dialog"
import { Empty, EmptyHeader, EmptyTitle } from "../base/empty"
import { Input } from "../base/input"
import { Spinner } from "../base/spinner"
import { Select } from "../desktop/select"

export function Tags({ repo }: { repo: string }) {
  return <RepositoryTags key={repo} repo={repo} />
}

function RepositoryTags({ repo }: { repo: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [remotes, setRemotes] = useState<[string, string][]>([])
  const [remote, setRemote] = useState("")
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const operationLock = useRef(false)
  const lifetime = useRef(0)
  useEffect(
    () => () => {
      lifetime.current += 1
    },
    []
  )
  // reload after mutations.
  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError(null)
    setTags([])
    setRemotes([])
    void Promise.all([ipc.tags(repo), ipc.remotes(repo)])
      .then(([tags, remotes]) => {
        if (!active) return
        setTags(tags)
        setRemotes(remotes)
        setRemote(current => (remotes.some(([r]) => r === current) ? current : (remotes[0]?.[0] ?? "")))
      })
      .catch(e => active && setError(String(e)))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [repo, open, revision])
  async function act(tag: string, operation: "push" | "delete" | "deleteRemote") {
    if (operationLock.current || loading) return
    operationLock.current = true
    const generation = lifetime.current
    setBusy(true)
    setError(null)
    try {
      if (
        operation !== "push" &&
        !(await confirm(t("tags.confirmDelete", { tag, remote: operation === "delete" ? t("tags.local") : remote }), {
          kind: "warning"
        }))
      )
        return
      if (lifetime.current !== generation) return
      if (operation === "delete") await ipc.deleteTag(repo, tag)
      else await ipc.push(repo, remote, `${operation === "push" ? `refs/tags/${tag}` : ""}:refs/tags/${tag}`)
      if (lifetime.current === generation) setRevision(v => v + 1)
    } catch (e) {
      if (lifetime.current === generation) setError(String(e))
    } finally {
      operationLock.current = false
      if (lifetime.current === generation) setBusy(false)
    }
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t("tags.title")}
      </Button>
      <Dialog open={open} onOpenChange={value => !busy && setOpen(value)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("tags.title")}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 overflow-x-auto">
            <Input
              aria-label={t("tags.search")}
              placeholder={t("tags.search")}
              value={query}
              onChange={e => setQuery(e.currentTarget.value)}
            />
            <Select
              ariaLabel={t("pr.sourceRemote")}
              value={remote}
              disabled={busy || loading}
              onChange={e => setRemote(e.currentTarget.value)}>
              {remotes.map(([name]) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
            <span className="shrink-0">
              {tags.filter(tag => tag.includes(query)).length}/{tags.length}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || loading}
              onClick={() => setRevision(value => value + 1)}>
              {t("inbox.refresh")}
            </Button>
          </div>
          {loading && (
            <div role="status" aria-label={t("tags.loading")}>
              <Spinner />
            </div>
          )}
          {!loading && !error && tags.filter(tag => tag.includes(query)).length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t(query ? "tags.noMatch" : "tags.empty")}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
          <div className="max-h-80 overflow-auto">
            {tags
              .filter(tag => tag.includes(query))
              .map(tag => (
                <div key={tag} className="flex items-center gap-2 py-1">
                  <span className="min-w-0 flex-1 truncate">{tag}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || loading || !remote}
                    onClick={() => void act(tag, "push")}>
                    {t("tags.push")}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy || loading} onClick={() => void act(tag, "delete")}>
                    {t("tags.deleteLocal")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || loading || !remote}
                    onClick={() => void act(tag, "deleteRemote")}>
                    {t("tags.deleteRemote")}
                  </Button>
                </div>
              ))}
          </div>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
