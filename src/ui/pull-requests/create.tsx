import { openUrl } from "@tauri-apps/plugin-opener"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { hookFailureHandling } from "@/features/dialogs/store"
import { ipc } from "@/lib/ipc"
import { pullRequestCreationURL, type PullRequestTargets } from "@/lib/pull-request-navigation"
import type { Remote } from "@/models/app-state"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"

import { Select } from "../desktop/select"

export function CreatePullRequest({
  open,
  onOpenChange,
  repo,
  branch,
  onPushed
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  repo: string
  remote: Remote | null
  branch: string | null
  onPushed: () => void
}) {
  const { t } = useTranslation()
  const [remotes, setRemotes] = useState<[string, string][]>([])
  const [source, setSource] = useState("")
  const [context, setContext] = useState<PullRequestTargets | null>(null)
  const [target, setTarget] = useState(0)
  const [base, setBase] = useState("")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryVersion, setDiscoveryVersion] = useState(0)
  const submitting = useRef(false)
  const lifetime = useRef(0)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    submitting.current = false
    setBusy(false)
    return () => {
      lifetime.current += 1
    }
  }, [repo, branch, open])
  useEffect(() => {
    if (!open) return
    let active = true
    setDiscovering(true)
    setRemotes([])
    setSource("")
    setContext(null)
    setError(null)
    void Promise.all([ipc.remotes(repo), ipc.branchDetails(repo)])
      .then(([values, branches]) => {
        if (!active) return
        setRemotes(values)
        setDiscoveryVersion(value => value + 1)
        const tracking = branches.find(b => !b.remote && b.name === branch)?.upstreamRemoteName
        setSource(
          values.find(([name]) => name === tracking)?.[0] ??
            values.find(([name]) => name === "origin")?.[0] ??
            values[0]?.[0] ??
            ""
        )
      })
      .catch(e => active && setError(String(e)))
      .finally(() => active && setDiscovering(false))
    return () => {
      active = false
    }
  }, [open, repo, branch, revision])
  // revision is the explicit retry trigger.
  useEffect(() => {
    if (!open || !source || discovering) {
      setLoading(false)
      return
    }
    let active = true
    setContext(null)
    setLoading(true)
    setError(null)
    void ipc
      .pullRequestTargets(repo, source)
      .then(value => {
        if (!active) return
        setContext(value)
        setTarget(0)
        setBase(value.targets[0]?.defaultBranch ?? "")
      })
      .catch(e => active && setError(String(e)))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [repo, source, open, discovering, discoveryVersion])
  async function submit() {
    if (!context || !branch || submitting.current || loading || discovering) return
    submitting.current = true
    const generation = lifetime.current
    setBusy(true)
    setError(null)
    try {
      const url = pullRequestCreationURL(context, target, branch, base)
      // pre-push 失败时照 Desktop _push 问；中止就不再去网页建 PR，也不报错
      const { onHookFailure, ignoreAborted } = hookFailureHandling()
      const pushed = await ignoreAborted(
        ipc.push(repo, source, `HEAD:refs/heads/${branch}`, true, false, { onHookFailure }).then(() => true),
        false
      )
      if (!pushed || lifetime.current !== generation) return
      onPushed()
      await openUrl(url)
      if (lifetime.current === generation) onOpenChange(false)
    } catch (e) {
      if (lifetime.current === generation) setError(String(e))
    } finally {
      if (lifetime.current === generation) {
        submitting.current = false
        setBusy(false)
      }
    }
  }
  return (
    <Dialog open={open} onOpenChange={value => !busy && onOpenChange(value)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pr.create")}</DialogTitle>
        </DialogHeader>
        <Select
          label={t("pr.sourceRemote")}
          value={source}
          disabled={busy}
          onChange={e => setSource(e.currentTarget.value)}>
          {remotes.map(([name, url]) => (
            <option key={name} value={name}>
              {name} — {url}
            </option>
          ))}
        </Select>
        {(loading || discovering) && <Spinner />}
        {context && (
          <>
            <Select
              label={t("pr.targetRepo")}
              value={String(target)}
              disabled={busy}
              onChange={e => {
                const index = Number(e.currentTarget.value)
                setTarget(index)
                setBase(context.targets[index].defaultBranch)
              }}>
              {context.targets.map((r, i) => (
                <option key={r.fullName} value={i}>
                  {r.fullName}
                </option>
              ))}
            </Select>
            <Select
              label={t("pr.basePlaceholder")}
              value={base}
              disabled={busy}
              onChange={e => setBase(e.currentTarget.value)}>
              {context.targets[target]?.branches.map(b => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {error && (
            <Button variant="outline" disabled={busy || loading || discovering} onClick={() => setRevision(v => v + 1)}>
              {t("inbox.refresh")}
            </Button>
          )}
          <Button
            disabled={busy || loading || discovering || !context || !branch || !base || !source}
            onClick={() => void submit()}>
            {busy && <Spinner />}
            {t("pr.createAndOpen")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
