import { open } from "@tauri-apps/plugin-dialog"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { usePreferencesStore } from "@/features/preferences/store"
import { ipc } from "@/lib/ipc"
import { showContextualMenu } from "@/lib/menu/menu-item"
import type { Worktree } from "@/models/app-state"
import { Repository } from "@/models/repository"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select } from "../desktop/select"
import { DeleteWorktreeDialog } from "./delete-worktree-dialog"
import { RenameWorktreeDialog } from "./rename-worktree-dialog"
import { generateWorktreeContextMenuItems } from "./worktree-list-item-context-menu"

export function Worktrees({
  repo,
  onClose,
  onOpen,
  onMove
}: {
  repo: string
  onClose: () => void
  onOpen: (path: string) => void
  onMove: (oldPath: string, newPath: string) => void
}) {
  const { t } = useTranslation()
  const repository = useMemo(() => new Repository(repo, -1, null, false), [repo])
  const [trees, setTrees] = useState<Worktree[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [branch, setBranch] = useState("")
  const [start, setStart] = useState("HEAD")
  const [path, setPath] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [deleting, setDeleting] = useState<Worktree | null>(null)
  const [renaming, setRenaming] = useState<Worktree | null>(null)
  const confirmWorktreeRemoval = usePreferencesStore(s => s.confirmWorktreeRemoval)
  const deleteWorktree = async (path: string) => {
    setError(null)
    try {
      await ipc.removeWorktree(repo, path)
      setRevision(v => v + 1)
    } catch (e) {
      setError(String(e))
    }
  }
  // Desktop _requestDeleteWorktree：关了「删除工作树前确认」就直接删；目录已不在的总要确认
  const requestDelete = (tree: Worktree) => {
    if (confirmWorktreeRemoval || tree.prunable) setDeleting(tree)
    else void deleteWorktree(tree.path)
  }
  // Desktop Dispatcher.moveWorktree: failures are surfaced and reported as `false`.
  const renameDispatcher = {
    moveWorktree: async (_repository: Repository, worktreePath: string, newPath: string) => {
      setError(null)
      try {
        await ipc.moveWorktree(repo, worktreePath, newPath)
      } catch (e) {
        setError(String(e))
        return false
      }
      onMove(worktreePath, newPath)
      setRevision(v => v + 1)
      return true
    }
  }
  const contextMenu = (tree: Worktree) =>
    showContextualMenu(
      generateWorktreeContextMenuItems({
        path: tree.path,
        isMainWorktree: tree.main,
        isLocked: !!tree.locked,
        onRenameWorktree: () => setRenaming(tree),
        onRemoveWorktree: () => requestDelete(tree)
      })
    )
  // revision reloads after a mutation.
  useEffect(() => {
    let active = true
    void Promise.all([ipc.worktrees(repo), ipc.branches(repo)])
      .then(([trees, branches]) => {
        if (active) {
          setTrees(trees)
          setBranches(branches.map(b => b.name))
        }
      })
      .catch(e => active && setError(String(e)))
    return () => {
      active = false
    }
  }, [repo, revision])
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      await ipc.addWorktreeAt(
        repo,
        path.trim(),
        branches.includes(branch) ? undefined : branch.trim(),
        branches.includes(branch) ? branch : start
      )
      setRevision(v => v + 1)
      setPath("")
      setBranch("")
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Dialog open onOpenChange={value => !value && !busy && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("worktree.title")}</DialogTitle>
          </DialogHeader>
          <div className="max-h-64 overflow-auto">
            {trees.map(tree => (
              <div
                key={tree.path}
                className="flex items-center gap-2 py-2"
                onContextMenu={event => {
                  event.preventDefault()
                  void contextMenu(tree)
                }}>
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 justify-start"
                  disabled={busy || !!tree.prunable || tree.kind === "bare"}
                  onClick={() => {
                    onOpen(tree.path)
                    onClose()
                  }}>
                  <span className="truncate" title={tree.path}>
                    {tree.branch ?? tree.path}
                  </span>
                </Button>
                <span className="text-muted-foreground max-w-64 truncate text-xs" title={tree.path}>
                  {tree.path}
                </span>
                {!tree.main && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !!tree.locked}
                      onClick={() => setRenaming(tree)}>
                      {t("worktree.rename")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || tree.path === repo || !!tree.locked}
                      onClick={() => requestDelete(tree)}>
                      {t("worktree.remove")}
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
          <FieldGroup>
            <Field>
              <FieldLabel>{t("worktree.branch")}</FieldLabel>
              <Input
                disabled={busy}
                value={branch}
                onChange={e => setBranch(e.currentTarget.value)}
                list="worktree-branches"
              />
              <datalist id="worktree-branches">
                {branches.map(b => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </Field>
            {!branches.includes(branch) && (
              <Select
                label={t("worktree.startPoint")}
                value={start}
                disabled={busy}
                onChange={e => setStart(e.currentTarget.value)}>
                <option value="HEAD">HEAD</option>
                {branches.map(b => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            )}
            <Field>
              <FieldLabel>{t("worktree.path")}</FieldLabel>
              <div className="flex gap-2">
                <Input disabled={busy} value={path} onChange={e => setPath(e.currentTarget.value)} />
                <Button
                  variant="outline"
                  disabled={busy || !branch.trim()}
                  onClick={() =>
                    void open({ directory: true, multiple: false })
                      .then(parent => {
                        if (typeof parent === "string") setPath(`${parent}/${branch.trim().replaceAll("/", "-")}`)
                      })
                      .catch(e => setError(String(e)))
                  }>
                  {t("worktree.chooseParent")}
                </Button>
              </div>
            </Field>
          </FieldGroup>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
          <Button disabled={busy || !path.trim() || !branch.trim()} onClick={() => void create()}>
            {t("worktree.create")}
          </Button>
        </DialogContent>
      </Dialog>
      {renaming && (
        <RenameWorktreeDialog
          repository={repository}
          worktreePath={renaming.path}
          dispatcher={renameDispatcher}
          onDismissed={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <DeleteWorktreeDialog
          repository={repository}
          worktreePath={deleting.path}
          options={{ isMissing: !!deleting.prunable }}
          askForConfirmationOnWorktreeRemoval={confirmWorktreeRemoval}
          onConfirmWorktreeRemovalChanged={value =>
            usePreferencesStore.getState().setPrompt("confirmWorktreeRemoval", value)
          }
          onDismissed={() => setDeleting(null)}
          onDeleteWorktree={(_repo, path) => deleteWorktree(path)}
        />
      )}
    </>
  )
}
