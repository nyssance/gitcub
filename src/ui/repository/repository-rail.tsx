import {
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  ChevronDownIcon,
  DotFillIcon,
  FlameIcon,
  GearIcon,
  MarkGithubIcon,
  PlusIcon,
  SearchIcon
} from "@primer/octicons-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { UserIcon } from "lucide-react"
import { type CSSProperties, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { useRepositoryIndicatorsStore } from "@/features/repository-indicators/store"
import { useRepositoryStore } from "@/features/repository/store"
import { accountEmptyState } from "@/lib/account-state"
import { avatarUrl } from "@/lib/avatar"
import { ipc } from "@/lib/ipc"
import { type Route, routes } from "@/lib/navigate"
import type { Accounts, Ownership, Remote } from "@/models/app-state"
import type { ILocalRepositoryState } from "@/models/repository"
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/base/avatar"
import { Badge } from "@/ui/base/badge"
import { Button } from "@/ui/base/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/base/collapsible"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/ui/base/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from "@/ui/base/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/base/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/base/input-group"
import { ScrollArea } from "@/ui/base/scroll-area"
import {
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from "@/ui/base/sidebar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/base/tabs"
import { InlineError } from "@/ui/shared/inline-error"

/** 左栏导航：仓库列表。
 *
 * 使用标准 shadcn Sidebar、InputGroup 和胶囊 Tabs；内容区按归属展示仓库，
 * 底部用户菜单沿用 ALwith Desktop 的设置入口。
 *
 * 分两页是因为官方那种「所有仓库一个平铺列表」不好使：拉下来看的三方仓库
 * 不需要分组，自己的项目才要按 GitHub / GitLab 归拢。所以：
 *   我的   —— 按 origin 的 host 分成 GitHub / GitLab 两组（可折叠）
 *   第三方 —— 平铺，不分组
 * 归属先按 origin 的 owner 跟账号 login 比，用户可以右键改，手动结果优先。 */

const nameOf = (p: string) => p.split("/").findLast(Boolean) ?? p
type Tab = "mine" | "third"

/** 分组标题：公有实例给品牌名，自建实例就写主机名——「其他」什么都没说明。 */
const hostLabel = (host: string) => {
  if (host === "github.com") return "GitHub"
  if (host === "gitlab.com") return "GitLab"
  return host
}

/** 自动判定：origin 的 owner 命中你在那个 host 上的命名空间（登录名或你所属的
 *  组织/群组）就是自己的。只比登录名不够——自己的项目常常挂在组织下。
 *  判不出来（没 origin、没凭据、离线）一律当第三方。 */
const autoOwnership = (remote: Remote | null, accounts: Accounts): Ownership => {
  if (!remote) return "third"
  const account = accounts[remote.host]
  if (!account || account.ignored) return "third"
  const owner = remote.owner.toLowerCase()
  // GitLab 的子组要按前缀算：owner=group/subgroup 属于 group
  return [account.login, ...account.owners].some(o => {
    if (!o) return false
    const ns = o.toLowerCase()
    return owner === ns || owner.startsWith(`${ns}/`)
  })
    ? "mine"
    : "third"
}

/** Desktop repository-list-item.tsx renderRepoIndicators：领先／落后的箭头，再加未提交改动的圆点。 */
function RepoIndicators({ state }: { state: ILocalRepositoryState | undefined }) {
  const { t } = useTranslation()
  if (!state) return null
  const { ahead, behind } = state.aheadBehind ?? { ahead: 0, behind: 0 }
  const tooltip = [
    behind > 0 && t("rail.behindTrackedBranch", { count: behind }),
    ahead > 0 && t("rail.aheadOfTrackedBranch", { count: ahead })
  ]
    .filter(Boolean)
    .join("\n")
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {tooltip && (
        <span
          className="bg-sidebar-accent text-sidebar-accent-foreground flex h-3 items-center rounded-full px-0.5"
          title={tooltip}
          data-testid="repository-ahead-behind">
          {ahead > 0 && <ArrowUpIcon size={12} />}
          {behind > 0 && <ArrowDownIcon size={12} />}
        </span>
      )}
      {state.changedFilesCount > 0 && (
        <span className="text-primary flex" title={t("rail.uncommittedChanges")} data-testid="repository-changes">
          <DotFillIcon size={12} />
        </span>
      )}
    </span>
  )
}

interface Props {
  repositories: string[]
  /** 当前路由。选中态由它推导——右侧开着「发现」时仓库行就不该是选中的 */
  route: Route
  trendingActive?: boolean
  onNavigate: (uri: string) => void
  /** 各仓库的 origin，由 App 统一读取（设置页也要用） */
  remotes: Record<string, Remote | null>
  remoteErrors?: Record<string, string>
  /** 各实例的账号，同样由 App 统一持有——设置里登出后这里要跟着变 */
  accounts: Accounts
  current: string | null
  onAdd: () => void
  onNewRepo: () => void
  /** 提交身份（git config user.*），显示在栏底 */
  author?: { name: string; email: string }
  ownership: Record<string, Ownership>
  onOwnershipChange: (repo: string, value: Ownership | null) => void
  /** 从 fork 的源仓库拉取并快进 */
  onSyncUpstream: (repo: string) => void
}

export function RepositoryRail({
  repositories,
  route,
  trendingActive = false,
  onNavigate,
  remotes,
  remoteErrors,
  accounts,
  current,
  onAdd,
  onNewRepo,
  author,
  ownership,
  onOwnershipChange,
  onSyncUpstream
}: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>("mine")
  const [q, setQ] = useState("")
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const indicators = useRepositoryIndicatorsStore(s => s.byPath)
  const status = useRepositoryStore(s => s.status)
  // 当前仓库不归后台刷新管（Desktop getRepositoriesForIndicatorRefresh 排除了它），用工作区状态
  const indicatorOf = (r: string): ILocalRepositoryState | undefined =>
    r === current
      ? {
          aheadBehind: status.hasUpstream ? { ahead: status.ahead, behind: status.behind } : null,
          changedFilesCount: status.changes.length
        }
      : indicators[r]
  const buckets = useMemo(() => {
    const query = q.trim().toLowerCase()
    // 「我的」按 host 分组；没有 origin 的纯本地仓无法判断归属，列在「第三方」
    const mine = new Map<string, string[]>()
    const third: string[] = []
    for (const r of repositories) {
      if (remoteErrors?.[r] && !remotes[r] && !ownership[r]) continue
      if (query && !nameOf(r).toLowerCase().includes(query) && !r.toLowerCase().includes(query)) {
        continue
      }
      const remote = remotes[r] ?? null
      const who = ownership[r] ?? autoOwnership(remote, accounts)
      if (who !== "mine") {
        third.push(r)
        continue
      }
      const key = remote?.host ?? ""
      const list = mine.get(key)
      if (list) list.push(r)
      else mine.set(key, [r])
    }
    return { mine: [...mine.entries()].toSorted(([a], [b]) => a.localeCompare(b)), third }
  }, [repositories, remotes, remoteErrors, accounts, ownership, q])

  const mineCount = buckets.mine.reduce((n, [, list]) => n + list.length, 0)
  const accountState = accountEmptyState(accounts)
  const remoteError = repositories.map(path => remoteErrors?.[path]).find(Boolean)

  /** 一行一个仓库。不写第二行 owner：「我的」那页都是你自己的，
   *  「第三方」那页 owner 也不值得占一整行——想看完整路径 hover 就有。 */
  const row = (r: string) => (
    <SidebarMenuItem key={r}>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <SidebarMenuButton
              isActive={!trendingActive && route.kind === "repo" && r === current}
              type="button"
              title={r}
              onClick={() => onNavigate(routes.repo(r))}
              aria-current={!trendingActive && route.kind === "repo" && r === current ? "page" : undefined}
              className="w-full justify-start">
              <span className="min-w-0 flex-1 truncate text-left">{nameOf(r)}</span>
              <RepoIndicators state={indicatorOf(r)} />
            </SidebarMenuButton>
          }
        />
        <ContextMenuContent>
          <ContextMenuItem onClick={() => void ipc.openInEditor(r)}>{t("rail.openInEditor")}</ContextMenuItem>
          <ContextMenuItem onClick={() => void ipc.openInTerminal(r)}>{t("rail.openInTerminal")}</ContextMenuItem>
          <ContextMenuItem onClick={() => void ipc.revealInFileManager(r)}>{t("rail.reveal")}</ContextMenuItem>
          {remotes[r] && (
            <ContextMenuItem
              onClick={() => {
                const m = remotes[r]
                if (m) void openUrl(`https://${m.host}/${m.owner}/${m.name}`)
              }}>
              {t("rail.openInBrowser")}
            </ContextMenuItem>
          )}
          {remotes[r] && <ContextMenuItem onClick={() => onSyncUpstream(r)}>{t("rail.syncUpstream")}</ContextMenuItem>}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onOwnershipChange(r, "mine")}>{t("rail.moveToMine")}</ContextMenuItem>
          <ContextMenuItem onClick={() => onOwnershipChange(r, "third")}>{t("rail.moveToThird")}</ContextMenuItem>
          <ContextMenuItem onClick={() => onOwnershipChange(r, null)}>{t("rail.autoOwnership")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuItem>
  )

  const group = (host: string, list: string[]) => {
    if (list.length === 0) return null
    const open = !collapsed[host]
    const label = host === "" ? t("rail.local") : hostLabel(host)
    return (
      <Collapsible
        key={host}
        open={open}
        onOpenChange={value => setCollapsed(prev => ({ ...prev, [host]: !value }))}
        className="group/collapsible">
        <SidebarGroup>
          <SidebarGroupLabel render={<CollapsibleTrigger />} className="gap-2">
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            <Badge variant="secondary">{list.length}</Badge>
            <ChevronDownIcon className="-rotate-90 transition-transform group-data-open/collapsible:rotate-0" />
          </SidebarGroupLabel>
          <CollapsibleContent>
            <SidebarGroupContent>
              <SidebarMenu>{list.map(r => row(r))}</SidebarMenu>
            </SidebarGroupContent>
          </CollapsibleContent>
        </SidebarGroup>
      </Collapsible>
    )
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "mine", label: t("rail.mine") },
    { key: "third", label: t("rail.thirdParty") }
  ]

  return (
    <SidebarProvider className="h-full min-h-0 w-60 shrink-0" style={{ "--sidebar-width": "15rem" } as CSSProperties}>
      <Sidebar collapsible="none" className="repository-rail bg-transparent">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={!trendingActive && ["mine", "stars"].includes(route.kind)}
                onClick={() => onNavigate(routes.mine())}
                aria-current={!trendingActive && ["mine", "stars"].includes(route.kind) ? "page" : undefined}>
                <span>GitCub</span>
              </SidebarMenuButton>
              {/* 「待办」是通知铃铛，和加号并排放在品牌名右侧，不单独占一行 */}
              <SidebarMenuAction
                type="button"
                className="right-8"
                title={t("inbox.title")}
                aria-label={t("inbox.title")}
                aria-current={!trendingActive && route.kind === "inbox" ? "page" : undefined}
                onClick={() => onNavigate(routes.inbox())}>
                <BellIcon size={16} />
              </SidebarMenuAction>
              {/* 加号是个菜单：添加已有的，或者新建一个 */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuAction
                      type="button"
                      title={t("rail.addRepository")}
                      aria-label={t("rail.addRepository")}>
                      <PlusIcon size={16} />
                    </SidebarMenuAction>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={onAdd}>{t("rail.addRepository")}</DropdownMenuItem>
                    <DropdownMenuItem onClick={onNewRepo}>{t("rail.newRepository")}</DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        {/* 「发现」是和仓库列表并列的目的地（趋势榜看的是网上的仓库），
          所以排在列表上面，不塞进列表的 tab 里。 */}
        <SidebarGroup className="shrink-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={trendingActive}
                  type="button"
                  onClick={() => onNavigate(routes.discover())}
                  className="w-full justify-start"
                  aria-current={trendingActive ? "page" : undefined}>
                  <FlameIcon size={16} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">{t("rail.discover")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <div className="shrink-0 px-2 pb-2">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon size={14} />
            </InputGroupAddon>
            <InputGroupInput
              value={q}
              onChange={e => setQ(e.currentTarget.value)}
              placeholder={t("rail.searchRepositories")}
              onKeyDown={e => e.key === "Escape" && setQ("")}
            />
          </InputGroup>
        </div>

        <Tabs
          value={tab}
          className="min-h-0 flex-1 gap-0"
          onValueChange={value => {
            setTab(value as Tab)
          }}>
          <TabsList className="mx-2 mb-2 w-auto shrink-0" aria-label={t("rail.repositories")}>
            {tabs.map(it => (
              <TabsTrigger key={it.key} value={it.key}>
                {it.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="mine" className="min-h-0 overflow-hidden">
            {remoteError && <InlineError error={remoteError} />}
            <ScrollArea className="h-full">
              <nav aria-label={t("rail.mine")}>
                {mineCount === 0 && remoteError ? null : mineCount === 0 ? (
                  /* 「我的」空着的时候别给一张白板：没登录就给登录入口，
               登录了还空就说清楚该怎么办（右键手动移）。
               账号验证失败（断网、令牌被拒）不是没登录：说明原因，入口是设置。 */
                  <Empty className="px-2 py-6">
                    <EmptyHeader>
                      <EmptyTitle className="text-xs">
                        {accountState.kind === "signedIn"
                          ? t("rail.emptyMine")
                          : accountState.kind === "failed"
                            ? t("rail.accountFailedTitle", { host: accountState.host })
                            : t("rail.signedOutTitle")}
                      </EmptyTitle>
                      <EmptyDescription className="text-[11px] wrap-anywhere">
                        {accountState.kind === "signedIn"
                          ? t("rail.emptyMineHint")
                          : accountState.kind === "failed"
                            ? accountState.error
                            : t("rail.signedOutHint")}
                      </EmptyDescription>
                    </EmptyHeader>
                    {accountState.kind !== "signedIn" && (
                      <EmptyContent>
                        <Button size="sm" onClick={() => onNavigate(routes.settings())}>
                          {accountState.kind === "failed" ? <GearIcon size={16} /> : <MarkGithubIcon size={16} />}
                          {accountState.kind === "failed" ? t("rail.openSettings") : t("rail.signInWithGitHub")}
                        </Button>
                      </EmptyContent>
                    )}
                  </Empty>
                ) : (
                  buckets.mine.map(([host, list]) => group(host, list))
                )}
              </nav>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="third" className="min-h-0 overflow-hidden">
            <ScrollArea className="h-full">
              <nav aria-label={t("rail.thirdParty")}>
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu>{buckets.third.map(row)}</SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </nav>
            </ScrollArea>
          </TabsContent>
        </Tabs>

        {/* 栏底：用户。设置在它弹出的菜单里——照 alwith-desktop 的
          NavUserDropdownContent。 */}
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton type="button">
                      <Avatar className="size-4">
                        <AvatarImage src={avatarUrl(author?.email)} alt={author?.name ?? ""} />
                        <AvatarFallback>
                          <UserIcon />
                        </AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1 truncate text-left">{author?.name ?? t("rail.noIdentity")}</span>
                    </SidebarMenuButton>
                  }
                />
                {/* 菜单跟随账号触发行宽度。 */}
                <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-(--anchor-width)">
                  {/* GroupLabel 必须在 Group 里，Base UI 少了它会抛 MenuGroupContext is missing */}
                  <DropdownMenuGroup>
                    {author?.email && (
                      <DropdownMenuLabel className="text-muted-foreground font-normal">
                        {author.email}
                      </DropdownMenuLabel>
                    )}
                    <DropdownMenuItem onClick={() => onNavigate(routes.settings())}>
                      <GearIcon size={16} />
                      {t("prefs.title")}
                      <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
    </SidebarProvider>
  )
}
