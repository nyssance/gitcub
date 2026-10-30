import { FileDirectoryIcon, GitBranchIcon, PlusIcon, TrashIcon } from "@primer/octicons-react"
import { listen } from "@tauri-apps/api/event"
import { useEffect, useEffectEvent, useState } from "react"
import { useTranslation } from "react-i18next"

import { getDesktopRuntime } from "@/lib/desktop-runtime"
import { ipc } from "@/lib/ipc"
import { useRepositoryPolicy } from "@/lib/use-repository-policy"
import { cn } from "@/lib/utils"
import type { BranchDetails, Worktree } from "@/models/app-state"
import { Button as StandardButton } from "@/ui/base/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/ui/base/context-menu"
import { Input } from "@/ui/base/input"
import { Separator } from "@/ui/base/separator"
import { match } from "@/upstream/lib/fuzzy-find"
import { sanitizedRefName } from "@/upstream/lib/sanitize-ref-name"
import { shouldShowWorktreeDropdown } from "@/upstream/lib/worktree-dropdown"

import { getBranches } from "../../lib/desktop-git"
import { findDefaultBranch } from "../../lib/find-default-branch"
import { Branch as DesktopBranch, BranchType } from "../../models/branch"
import { type Tip, TipState } from "../../models/tip"
import { CreateBranch } from "../create-branch/create-branch-dialog"
import { ToolbarDropdown } from "./toolbar-dropdown"

interface Props {
  repo: string | null
  branch: string | null
  onCheckout: (name: string) => Promise<void>
  onCreate: (name: string, startPoint?: string, noTrack?: boolean) => Promise<void>
  onDelete: (name: string) => Promise<void>
  /** 把另一条分支合并到当前分支 */
  onMerge: (name: string, squash: boolean) => Promise<void>
  /** 把当前分支变基到另一条分支上 */
  onRebase: (name: string) => Promise<void>
  /** 只报「要改哪条」，新名字由上层问——webview 里 window.prompt 是死的 */
  onRename: (from: string) => void
  onWorktrees: () => void
  onOpenWorktree: (path: string) => void
}

export function BranchDropdown({
  repo,
  branch,
  onCheckout,
  onCreate,
  onDelete,
  onMerge,
  onRebase,
  onRename,
  onWorktrees,
  onOpenWorktree
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [list, setList] = useState<BranchDetails[]>([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runtime = getDesktopRuntime()
  const [accounts, setAccounts] = useState(runtime.appStore.getState().accounts)
  useEffect(() => {
    const sub = runtime.accountsStore.onDidUpdate(setAccounts)
    return () => sub.dispose()
  }, [runtime])
  const policy = useRepositoryPolicy(repo ?? "", branch, accounts)
  const repository = policy.repository
  const [action, setAction] = useState<string | null>(null)
  const [createDialog, setCreateDialog] = useState<{
    branches: readonly DesktopBranch[]
    tip: Exclude<Tip, { kind: TipState.Unknown }>
    defaultBranch: DesktopBranch | null
  } | null>(null)
  const showCreateDialog = async () => {
    if (!repo) return
    try {
      const [branches, tip] = await Promise.all([getBranches(repository), ipc.repositoryTip(repo)])
      const currentTip =
        tip.kind === "Valid"
          ? {
              kind: TipState.Valid as const,
              branch: new DesktopBranch(
                tip.branch.name,
                tip.branch.upstream,
                { sha: tip.branch.sha },
                tip.branch.remote ? BranchType.Remote : BranchType.Local,
                tip.branch.reference
              )
            }
          : tip.kind === "Detached"
            ? { kind: TipState.Detached as const, currentSha: tip.currentSha }
            : { kind: TipState.Unborn as const, ref: tip.ref }
      setCreateDialog({
        branches,
        tip: currentTip,
        defaultBranch: await findDefaultBranch(
          repository,
          branches,
          (await ipc.remotes(repo)).find(([name]) => name === "origin")?.[0] ?? (await ipc.remotes(repo))[0]?.[0]
        )
      })
      setOpen(false)
    } catch (error) {
      setError(String(error))
    }
  }

  const onMenu = useEffectEvent((payload: string) => {
    if (!repo) return
    if (payload === "create-branch") void showCreateDialog()
    if (["merge-branch", "squash-and-merge-branch", "rebase-branch"].includes(payload)) {
      setAction(payload)
      setOpen(true)
    }
  })
  useEffect(() => {
    const subscription = listen<string>("menu", event => onMenu(event.payload))
    return () => {
      void subscription.then(dispose => dispose())
    }
  }, [])

  // 只在展开时拉分支列表，避免每次 status 刷新都跑一遍引用遍历
  useEffect(() => {
    if (!open || !repo) return
    let active = true
    setList([])
    setLoadingBranches(true)
    setError(null)
    ipc
      .branchDetails(repo)
      .then(value => active && setList(value))
      .catch((e: unknown) => active && setError(String(e)))
      .finally(() => active && setLoadingBranches(false))
    return () => {
      active = false
    }
  }, [open, repo])

  const [trees, setTrees] = useState<Worktree[]>([])

  // 工作树和分支是同一类东西（都是「我现在在哪条线上干活」），放一起才好找
  useEffect(() => {
    if (!open || !repo) return
    let active = true
    setTrees([])
    ipc
      .worktrees(repo)
      .then(value => active && setTrees(value))
      .catch((e: unknown) => active && setError(String(e)))
    return () => {
      active = false
    }
  }, [open, repo])

  const isCurrent = (candidate: BranchDetails) => !candidate.remote && candidate.name === branch
  const shown = q.trim() ? match(q.trim(), list, branch => [branch.name]).map(result => result.item) : list
  // 筛选词不匹配任何分支时，把它当作新分支名 —— 和原版一样，
  // 搜索框兼作「新建分支」的输入
  const proposedName = sanitizedRefName(q.trim())
  const canCreate = !loadingBranches && !error && proposedName.length > 0 && !list.some(b => b.name === proposedName)

  return (
    <>
      <div className="branch-button flex min-w-0 flex-1">
        <ToolbarDropdown
          icon={<GitBranchIcon size={16} className="shrink-0" />}
          title={t("toolbar.currentBranch")}
          description={branch ?? "—"}
          grow
          disabled={!repo}
          open={open}
          onOpenChange={value => {
            setOpen(value)
            if (!value) setAction(null)
          }}>
          {/* 下拉面板：固定高度、列表内部滚动 —— 不是铺满整列的抽屉 */}
          <div className="flex max-h-[380px] flex-col">
            {action && <p className="px-3 py-2 text-xs">{t(`branch.action_${action}`)}</p>}
            <StandardButton
              variant="ghost"
              type="button"
              className="new-branch-button px-3 py-2 text-left text-xs"
              onClick={() => {
                void showCreateDialog()
              }}>
              {t("toolbar.newBranch")}
            </StandardButton>
            <StandardButton
              variant="ghost"
              type="button"
              className="px-3 py-2 text-left text-xs"
              onClick={() => {
                setOpen(false)
                onWorktrees()
              }}>
              {t("worktree.title")}
            </StandardButton>
            <div className="p-2">
              <Input
                value={q}
                onChange={e => setQ(e.currentTarget.value)}
                placeholder={t("toolbar.filterBranches")}
                className="h-7 text-xs"
              />
            </div>
            {canCreate && (
              <>
                <Separator />
                <StandardButton
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    const name = proposedName
                    setQ("")
                    setOpen(false)
                    void onCreate(name)
                  }}
                  className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
                  <PlusIcon size={16} className="shrink-0" />
                  <span className="truncate">{t("toolbar.createBranch", { name: proposedName })}</span>
                </StandardButton>
              </>
            )}
            <Separator />
            {/* 只有真的开了额外工作树才显示——只有主仓库时这一段是纯噪音 */}
            {shouldShowWorktreeDropdown(trees.length, false, false) && (
              <>
                <div className="text-muted-foreground px-3 pt-2 text-[10px] font-semibold">{t("worktree.title")}</div>
                {trees.map(w => (
                  <div key={w.path} className="flex items-center gap-2 px-3 py-1 text-xs">
                    <FileDirectoryIcon size={14} className="text-muted-foreground shrink-0" />
                    <StandardButton
                      variant="ghost"
                      type="button"
                      disabled={!!w.prunable || w.kind === "bare"}
                      onClick={() => {
                        setOpen(false)
                        onOpenWorktree(w.path)
                      }}
                      className="min-w-0 flex-1 truncate text-left"
                      title={w.path}>
                      {w.branch ?? w.path.split("/").pop()}
                    </StandardButton>
                    {w.main ? (
                      <span className="text-muted-foreground shrink-0 text-[10px]">{t("worktree.main")}</span>
                    ) : (
                      <StandardButton
                        variant="ghost"
                        type="button"
                        title={t("worktree.remove")}
                        onClick={() => {
                          setOpen(false)
                          onWorktrees()
                        }}
                        className="text-muted-foreground hover:text-destructive shrink-0">
                        <TrashIcon size={12} />
                      </StandardButton>
                    )}
                  </div>
                ))}
                <Separator />
              </>
            )}
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {error && <p className="text-destructive px-3 py-4 text-xs">{error}</p>}
              {!error && shown.length === 0 && (
                <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t("toolbar.noBranches")}</p>
              )}
              {shown.map(b => (
                /* 右键菜单＝原版分支菜单里的那几项：合并、压缩合并、变基、重命名、删除。
               合并/变基的方向是固定的：把这条分支合并「到当前分支」，
               把当前分支变基「到这条分支上」——反过来是另一回事，不给选。 */
                <ContextMenu key={b.name}>
                  <ContextMenuTrigger
                    render={
                      <div
                        className={cn(
                          "branches-list-item group/branch hover:bg-accent flex w-full items-center gap-2 px-3 py-1.5 text-xs",
                          isCurrent(b) && "font-semibold"
                        )}
                      />
                    }>
                    <StandardButton
                      variant="ghost"
                      type="button"
                      disabled={!!action && isCurrent(b)}
                      onClick={() => {
                        setOpen(false)
                        if (action === "merge-branch") void onMerge(b.reference, false)
                        else if (action === "squash-and-merge-branch") void onMerge(b.reference, true)
                        else if (action === "rebase-branch") void onRebase(b.reference)
                        else void onCheckout(b.remote ? b.reference : b.name)
                        setAction(null)
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <GitBranchIcon size={16} className="text-muted-foreground shrink-0" />
                      <div className="name truncate">{b.name}</div>
                    </StandardButton>
                    {isCurrent(b) ? (
                      <span className="text-muted-foreground shrink-0 text-[10px]">{t("toolbar.current")}</span>
                    ) : !b.remote ? (
                      <StandardButton
                        variant="ghost"
                        type="button"
                        title={t("common.delete")}
                        onClick={() => {
                          setOpen(false)
                          void onDelete(b.name)
                        }}
                        className="text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover/branch:opacity-100">
                        <TrashIcon size={14} />
                      </StandardButton>
                    ) : null}
                  </ContextMenuTrigger>

                  <ContextMenuContent>
                    {!isCurrent(b) && (
                      <>
                        <ContextMenuItem
                          onClick={() => {
                            setOpen(false)
                            void onMerge(b.reference, false)
                          }}>
                          {t("branch.merge", { name: b.name, current: branch ?? "" })}
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() => {
                            setOpen(false)
                            void onMerge(b.reference, true)
                          }}>
                          {t("branch.squashMerge", { name: b.name })}
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() => {
                            setOpen(false)
                            void onRebase(b.reference)
                          }}>
                          {t("branch.rebase", { name: b.name })}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                      </>
                    )}
                    {!b.remote && (
                      <ContextMenuItem
                        onClick={() => {
                          setOpen(false)
                          onRename(b.name)
                        }}>
                        {t("branch.rename")}
                      </ContextMenuItem>
                    )}
                    {!isCurrent(b) && !b.remote && (
                      <ContextMenuItem
                        onClick={() => {
                          setOpen(false)
                          void onDelete(b.name)
                        }}>
                        {t("common.delete")}
                      </ContextMenuItem>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          </div>
        </ToolbarDropdown>
      </div>
      {createDialog && (
        <CreateBranch
          repository={repository}
          tip={createDialog.tip}
          allBranches={createDialog.branches}
          defaultBranch={createDialog.defaultBranch}
          upstreamDefaultBranch={null}
          upstreamGitHubRepository={null}
          accounts={accounts}
          cachedRepoRulesets={policy.rulesets}
          initialName={q}
          onDismissed={() => setCreateDialog(null)}
          dispatcher={{
            createBranch: async (_repository, name, startPoint, noTrack) => {
              await onCreate(name, startPoint ?? undefined, noTrack)
              return (await getBranches(repository)).find(branch => branch.name === name)
            },
            showPopup: popup => {
              setError(`Cannot create branch: ${popup.type}`)
            }
          }}
        />
      )}
    </>
  )
}
