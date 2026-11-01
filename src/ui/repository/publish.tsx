import { useState } from "react"
import { useTranslation } from "react-i18next"

import { hookFailureHandling } from "@/features/dialogs/store"
import { ipc } from "@/lib/ipc"
import { Button } from "@/ui/base/button"
import { Checkbox } from "@/ui/base/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ui/base/dialog"
import { Field, FieldLabel } from "@/ui/base/field"
import { Input } from "@/ui/base/input"
import { NativeSelect } from "@/ui/base/native-select"

/** 发布仓库：在远端建一个空仓库，配上 origin，把当前分支推上去。
 *
 * 默认私有——把本来在本地的东西一键变成公开的，不该是默认行为。 */
export function PublishRepository({
  open,
  onOpenChange,
  repo,
  branch,
  hosts,
  onPublished
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  repo: string
  branch: string | null
  /** 已登录的实例；发布到哪个由用户选 */
  hosts: string[]
  onPublished: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(repo.split("/").findLast(Boolean) ?? "")
  const [host, setHost] = useState(hosts[0] ?? "github.com")
  const [isPrivate, setPrivate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const url = await ipc.createRemoteRepo(host, name.trim(), isPrivate)
      await ipc.addRemote(repo, "origin", url)
      // Desktop _publishRepository 走 _push：pre-push 失败时问，中止就不报错（仓库已经建好）
      const { onHookFailure, ignoreAborted } = hookFailureHandling()
      await ignoreAborted(
        ipc.push(repo, "origin", `HEAD:refs/heads/${branch ?? "main"}`, true, false, { onHookFailure }),
        undefined
      )
      onPublished()
      onOpenChange(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("publish.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="publish-name">{t("publish.name")}</FieldLabel>
            <Input id="publish-name" value={name} onChange={e => setName(e.currentTarget.value)} className="h-8" />
          </Field>

          <Field>
            <FieldLabel htmlFor="publish-host">{t("publish.host")}</FieldLabel>
            <NativeSelect
              id="publish-host"
              value={host}
              onChange={e => setHost(e.currentTarget.value)}
              className="border-input h-8 rounded-md border bg-transparent px-2 text-xs">
              {hosts.map(h => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </NativeSelect>
          </Field>

          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={isPrivate} onCheckedChange={v => setPrivate(v)} />
            {t("publish.private")}
          </label>

          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void submit()}>
            {t("publish.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
