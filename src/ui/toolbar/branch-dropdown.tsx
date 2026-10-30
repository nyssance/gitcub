import { FileDirectoryIcon, GitBranchIcon } from "@primer/octicons-react"
import { listen } from "@tauri-apps/api/event"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { getDesktopRuntime } from "@/lib/desktop-runtime"
import { ipc } from "@/lib/ipc"
import { useRepositoryPolicy } from "@/lib/use-repository-policy"
import type { Worktree } from "@/models/app-state"
import { Button as StandardButton } from "@/ui/base/button"
import { shouldShowWorktreeDropdown } from "@/upstream/lib/worktree-dropdown"

import { getBranches } from "../../lib/desktop-git"
import { findDefaultBranch } from "../../lib/find-default-branch"
import { Branch as DesktopBranch, BranchType } from "../../models/branch"
import { type Tip, TipState } from "../../models/tip"
import { BranchList } from "../branches/branch-list"
import { getDefaultAriaLabelForBranch, renderDefaultBranch } from "../branches/branch-renderer"
import { CreateBranch } from "../create-branch/create-branch-dialog"
import { Button } from "../desktop/button"
import { Row } from "../desktop/row"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"
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
  const buttonRef = useRef<HTMLDivElement>(null)
  const [foldoutHeight, setFoldoutHeight] = useState(0)
  const measureFoldout = () => {
    // 留出 Base UI 定位器默认的 5px 碰撞边距（再多 1px 防取整），否则判定放不下、翻到按钮右侧
    if (buttonRef.current) setFoldoutHeight(window.innerHeight - buttonRef.current.getBoundingClientRect().bottom - 6)
  }
  const [q, setQ] = useState("")
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
  const [createName, setCreateName] = useState("")
  const showCreateDialog = async (name = "") => {
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
      setCreateName(name)
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
      measureFoldout()
      setOpen(true)
    }
  })
  useEffect(() => {
    const subscription = listen<string>("menu", event => onMenu(event.payload))
    return () => {
      void subscription.then(dispose => dispose())
    }
  }, [])

  // Desktop BranchesContainer 的数据来自 git-store loadBranches：本地分支 + 没有本地跟踪的远端分支、
  // reflog 里最近检出的分支、默认分支。只在展开时读，避免每次 status 刷新都跑一遍引用遍历。
  const [branches, setBranches] = useState<{
    all: ReadonlyArray<DesktopBranch>
    recent: ReadonlyArray<DesktopBranch>
    defaultBranch: DesktopBranch | null
  } | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<DesktopBranch | null>(null)
  const loadBranches = useEffectEvent(async (isActive: () => boolean) => {
    const gitStore = runtime.appStore.gitStoreFor(repository)
    const subscription = gitStore.onDidError(e => isActive() && setError(String(e)))
    try {
      await gitStore.loadRemotes()
      await gitStore.loadBranches()
      if (!isActive()) return
      const next = {
        all: gitStore.allBranches,
        recent: gitStore.recentBranches,
        defaultBranch: gitStore.defaultBranch
      }
      setBranches(next)
      setSelectedBranch(next.all.find(b => b.type === BranchType.Local && b.name === branch) ?? null)
    } catch (e) {
      if (isActive()) setError(String(e))
    } finally {
      subscription.dispose()
    }
  })
  useEffect(() => {
    if (!open || !repo) return
    let active = true
    setBranches(null)
    setError(null)
    void loadBranches(() => active)
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

  const currentBranch = branches?.all.find(b => b.type === BranchType.Local && b.name === branch) ?? null
  const close = () => {
    setOpen(false)
    setAction(null)
  }
  const onBranchItemClick = (picked: DesktopBranch) => {
    close()
    if (action === "merge-branch") void onMerge(picked.ref, false)
    else if (action === "squash-and-merge-branch") void onMerge(picked.ref, true)
    else if (action === "rebase-branch") void onRebase(picked.ref)
    else void onCheckout(picked.type === BranchType.Remote ? picked.ref : picked.name)
  }
  // 原版分支右键菜单（重命名、复制分支名、删除）之上，保留本项目的合并、压缩合并、变基。
  // 方向固定：把这条分支合并「到当前分支」，把当前分支变基「到这条分支上」。
  const extraContextMenuItems = (target: DesktopBranch) =>
    target.name === currentBranch?.name
      ? []
      : [
          {
            label: t("branch.merge", { name: target.name, current: branch ?? "" }),
            action: () => {
              close()
              void onMerge(target.ref, false)
            }
          },
          {
            label: t("branch.squashMerge", { name: target.name }),
            action: () => {
              close()
              void onMerge(target.ref, true)
            }
          },
          {
            label: t("branch.rebase", { name: target.name }),
            action: () => {
              close()
              void onRebase(target.ref)
            }
          }
        ]

  // 只有真的开了额外工作树才列出来——只有主仓库时这一段是纯噪音
  const renderPreList = () => (
    <>
      {action && <p className="branches-action-hint">{t(`branch.action_${action}`)}</p>}
      {shouldShowWorktreeDropdown(trees.length, false, false) && (
        <div className="branches-worktrees">
          <StandardButton
            variant="ghost"
            type="button"
            className="h-[30px] justify-start rounded-none px-[10px] text-xs font-semibold"
            onClick={() => {
              close()
              onWorktrees()
            }}>
            {t("worktree.title")}
          </StandardButton>
          {trees.map(w => (
            <StandardButton
              key={w.path}
              variant="ghost"
              type="button"
              disabled={!!w.prunable || w.kind === "bare"}
              onClick={() => {
                close()
                onOpenWorktree(w.path)
              }}
              className="branches-list-item h-[30px] justify-start rounded-none text-xs font-normal"
              title={w.path}>
              <FileDirectoryIcon size={16} className="icon" />
              <span className="name">{w.branch ?? w.path.split("/").pop()}</span>
              {w.main && <span className="description">{t("worktree.main")}</span>}
            </StandardButton>
          ))}
        </div>
      )}
    </>
  )

  return (
    <>
      <div ref={buttonRef} className="branch-button flex shrink-0">
        <ToolbarDropdown
          icon={<GitBranchIcon size={16} className="shrink-0" />}
          title={t("toolbar.currentBranch")}
          description={branch ?? "—"}
          // Desktop app-store defaultBranchDropdownWidth
          width={230}
          disabled={!repo}
          open={open}
          // Desktop branch-dropdown.tsx foldoutStyleOverrides：分支 foldout 最窄 365px；高度铺到窗口底部
          // （ToolbarDropdown 的 height:100%）。高度在打开时按按钮底边量好再给：先渲染再量会让定位器
          // 把一时放不下的面板翻到按钮右侧。
          foldoutStyle={{ width: 365, height: foldoutHeight }}
          onOpenChange={value => {
            if (value) measureFoldout()
            setOpen(value)
            if (!value) setAction(null)
          }}>
          <div className="branches-container">
            <div className="branches-container-panel">
              {error ? (
                <p className="no-branches">{error}</p>
              ) : branches === null ? null : (
                <BranchList
                  repository={repository}
                  defaultBranch={branches.defaultBranch}
                  currentBranch={currentBranch}
                  allBranches={branches.all}
                  recentBranches={branches.recent}
                  onItemClick={onBranchItemClick}
                  filterText={q}
                  onFilterTextChanged={setQ}
                  selectedBranch={selectedBranch}
                  onSelectionChanged={setSelectedBranch}
                  canCreateNewBranch={true}
                  onCreateNewBranch={name => void showCreateDialog(name)}
                  renderBranch={(item, matches, authorDate) =>
                    renderDefaultBranch(item, matches, currentBranch, authorDate)
                  }
                  getBranchAriaLabel={getDefaultAriaLabelForBranch}
                  renderPreList={renderPreList}
                  onRenameBranch={name => {
                    close()
                    onRename(name)
                  }}
                  onDeleteBranch={name => {
                    close()
                    void onDelete(name)
                  }}
                  extraContextMenuItems={extraContextMenuItems}
                />
              )}
            </div>
            {/* Desktop renderMergeButtonRow：HEAD 游离时不显示。原版点它开合并对话框；
                本项目没有那个对话框，进入同一个列表的「选分支合并」模式。 */}
            {branch !== null && (
              <Row className="merge-button-row">
                <Button className="merge-button" onClick={() => setAction("merge-branch")}>
                  <Octicon className="icon" symbol={octicons.gitMerge} />
                  {t("desktopUI.chooseBranchToMergeInto")} <strong>{branch}</strong>
                </Button>
              </Row>
            )}
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
          initialName={createName}
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
