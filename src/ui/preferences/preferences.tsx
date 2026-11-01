import {
  AccessibilityIcon,
  BellIcon,
  CheckIcon,
  CopyIcon,
  GearIcon,
  GitCommitIcon,
  HomeIcon,
  PaintbrushIcon,
  PersonIcon,
  QuestionIcon
} from "@primer/octicons-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Touchpad } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { type PreferencesTab, PreferencesTabs } from "@/features/preferences/store"
import { getGlobalConfigValue, setGlobalConfigValue } from "@/lib/desktop-git"
import { getDesktopRuntime } from "@/lib/desktop-runtime"
import { pollDeviceAuthorization } from "@/lib/device-authorization"
import i18n from "@/lib/i18n"
import { ipc } from "@/lib/ipc"
import { useTrackpadAvailability } from "@/lib/ui/use-trackpad-availability"
import type { Account, Accounts, AppState, DeviceStart } from "@/models/app-state"
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/base/avatar"
import { Button, Button as StandardButton } from "@/ui/base/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/ui/base/dialog"
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/ui/base/field"
import { Input } from "@/ui/base/input"
import { Separator } from "@/ui/base/separator"
import { Switch } from "@/ui/base/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/base/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/ui/base/toggle-group"
import { sanitizedRefName } from "@/upstream/lib/sanitize-ref-name"
import { gitAuthorNameIsValid, InvalidGitAuthorNameMessage } from "@/upstream/ui/lib/identifier-rules"

import { instanceFromURL } from "../../lib/account-host"
import { validateURL } from "../../lib/enterprise-validate-url"
import { Select } from "../desktop/select"
import { AutolinkRules } from "./autolink-rules"
import {
  AccessibilityTab,
  AppearanceFormatting,
  BackgroundUpdatesSettings,
  NotificationsTab,
  PromptsTab
} from "./desktop-settings"

/** Settings use the project's shadcn/Base UI Dialog and vertical Tabs.
 * The navigation, active state, focus and panel relationships belong to Tabs. */

/** 图标照原版各页签（home / person / gitCommit / paintbrush / bell / question / gear / accessibility） */
const TAB_ICONS: Record<PreferencesTab, React.ComponentType<{ size?: number; "data-icon"?: string }>> = {
  accounts: HomeIcon,
  integrations: PersonIcon,
  git: GitCommitIcon,
  appearance: PaintbrushIcon,
  notifications: BellIcon,
  prompts: QuestionIcon,
  advanced: GearIcon,
  accessibility: AccessibilityIcon,
  trackpad: Touchpad
}

interface Props {
  open: boolean
  initialTab?: PreferencesTab
  onOpenChange: (open: boolean) => void
  state: AppState
  onPatch: (p: Partial<AppState>) => void
  /** 要列出的实例（公有两家 + 仓库里出现过的 + 用户加的），由 App 统一算 */
  hosts: string[]
  /** 各实例的账号，由 App 统一持有 */
  accounts: Accounts
  /** 令牌/登出状态变了，通知 App 重新取一遍 */
  onAccountsChanged: () => void
}

/** 一组设置行。来自 alwith-desktop 的 SettingGroup。 */
function SettingGroup({ children }: { children: React.ReactNode }) {
  return <div className="w-full px-4">{children}</div>
}

/** 一行设置：左边标题（可带说明），右边控件。 */
function SettingRow({
  title,
  description,
  children
}: {
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm">{title}</div>
        {description && <div className="text-muted-foreground text-xs">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export function Preferences({
  open,
  onOpenChange,
  state,
  onPatch,
  hosts,
  accounts,
  onAccountsChanged,
  initialTab = "accounts"
}: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState(initialTab)
  useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 比默认大一圈：仓库页里有 .gitignore 编辑框，440 高只能看三四行 */}
      <DialogContent className="h-[560px] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {/* 左右分栏（照 alwith-desktop 的 AuxWindowShell）：
            左栏菜单从上到下通栏拉满、与右列之间一条发丝线；标题只属于右列。 */}
        <Tabs
          orientation="vertical"
          value={tab}
          onValueChange={value => {
            if (PreferencesTabs.includes(value)) setTab(value)
          }}
          className="h-full min-h-0 gap-0">
          <TabsList
            aria-label={t("prefs.title")}
            className="w-48 shrink-0 items-stretch justify-start gap-0.5 rounded-none border-r bg-transparent px-3 py-4 group-data-vertical/tabs:h-full">
            {PreferencesTabs.map(id => {
              const Icon = TAB_ICONS[id]
              return (
                <TabsTrigger key={id} value={id} className="h-9 flex-none justify-start gap-2 px-3">
                  <Icon data-icon="inline-start" size={16} />
                  <span>{t(`prefs.${id}`)}</span>
                </TabsTrigger>
              )
            })}
          </TabsList>

          <div className="flex min-w-0 flex-1 flex-col">
            <DialogHeader className="px-4 py-3">
              <DialogTitle>{t("prefs.title")}</DialogTitle>
            </DialogHeader>

            <TabsContent value="accounts" className="min-h-0 overflow-y-auto p-4">
              <AccountsTab
                hosts={hosts}
                accounts={accounts}
                clients={state.oauthClients}
                providers={state.oauthProviders ?? {}}
                onSetProvider={(h, kind) => onPatch({ oauthProviders: { ...state.oauthProviders, [h]: kind } })}
                onChanged={onAccountsChanged}
                onSetClient={(h, id) => onPatch({ oauthClients: { ...state.oauthClients, [h]: id } })}
                onAddHost={h =>
                  !state.accountHosts.includes(h) && onPatch({ accountHosts: [...state.accountHosts, h] })
                }
              />
            </TabsContent>
            <TabsContent value="integrations" className="min-h-0 overflow-y-auto p-4">
              <IntegrationSettings state={state} onPatch={onPatch} />
            </TabsContent>
            <TabsContent value="git" className="min-h-0 overflow-y-auto p-4">
              <GitTab />
            </TabsContent>
            <TabsContent value="appearance" className="min-h-0 overflow-y-auto p-4">
              <AppearanceTab theme={state.theme} onChange={theme => onPatch({ theme })} />
              <AppearanceFormatting />
            </TabsContent>
            <TabsContent value="notifications" className="min-h-0 overflow-y-auto p-4">
              <NotificationsTab />
            </TabsContent>
            <TabsContent value="prompts" className="min-h-0 overflow-y-auto p-4">
              <PromptsTab />
            </TabsContent>
            <TabsContent value="accessibility" className="min-h-0 overflow-y-auto p-4">
              <AccessibilityTab />
            </TabsContent>
            <TabsContent value="trackpad" className="min-h-0 overflow-y-auto p-4">
              <TrackpadTab
                enabled={state.canvasTrackpadGestures ?? false}
                onChange={canvasTrackpadGestures => onPatch({ canvasTrackpadGestures })}
              />
            </TabsContent>
            <TabsContent value="advanced" className="min-h-0 overflow-y-auto p-4">
              <BackgroundUpdatesSettings />
              <DesktopImportSettings state={state} onPatch={onPatch} />
              <AdvancedTab language={state.language} onChange={language => onPatch({ language })} />
              <SettingGroup>
                <AutolinkRules rules={state.autolinks ?? []} onChange={autolinks => onPatch({ autolinks })} />
              </SettingGroup>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

/** 账户：按实例（主机名）列出。
 *
 * 凭据不一定是这里粘的——机器上装了 gh / 用过 git 凭据助手就自动认出来，
 * 所以每行要说清「从哪儿来的」。退出登录会把系统里那份也一并停用，
 * 否则删掉自己的令牌下一秒又被捡回来。 */
export function AccountsTab({
  hosts,
  accounts,
  clients,
  providers,
  onSetProvider,
  onChanged,
  onAddHost,
  onSetClient
}: {
  hosts: string[]
  accounts: Accounts
  clients: Record<string, string>
  providers: Record<string, "github" | "gitlab">
  onSetProvider: (host: string, kind: "github" | "gitlab") => void
  onChanged: () => void
  onAddHost: (host: string) => void
  onSetClient: (host: string, clientId: string) => void
}) {
  const { t } = useTranslation()
  const [device, setDevice] = useState<{ host: string; start: DeviceStart } | null>(null)
  /** 授权码已复制：换一个码（重新登录或取消）就回到复制图标 */
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [device])
  const [clientDraft, setClientDraft] = useState<Record<string, string>>({})
  // 内置的应用 ID：有内置的就不用让用户填，直接给「登录」按钮
  const [builtin, setBuiltin] = useState<Record<string, string>>({})

  useEffect(() => {
    ipc
      .oauthDefaultClients()
      .then(setBuiltin)
      .catch(() => {})
  }, [])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [newHost, setNewHost] = useState("")
  const loginAttempt = useRef<AbortController | null>(null)
  useEffect(() => () => loginAttempt.current?.abort(), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (host: string) => {
    setBusy(true)
    setError(null)
    try {
      await ipc.setToken(host, draft[host] ?? "")
      setDraft(d => ({ ...d, [host]: "" }))
      await getDesktopRuntime().synchronizeAccounts([host])
      onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (host: string, ignored: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await ipc.setAccountIgnored(host, ignored)
      await getDesktopRuntime().synchronizeAccounts([host])
      onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  /** The backend also cancels persistence of responses already in flight. */
  const signIn = async (host: string) => {
    // 用户填过就用他的，否则用内置的（后端也会兜一次）
    const clientId = clients[host] ?? builtin[host] ?? ""
    if (!clientId) return
    loginAttempt.current?.abort()
    const attempt = new AbortController()
    const attemptId = crypto.randomUUID()
    const cancel = () => {
      void ipc.oauthDeviceCancel(host, attemptId).catch(error => log.error("Unable to cancel sign-in", error))
    }
    attempt.signal.addEventListener("abort", cancel, { once: true })
    loginAttempt.current = attempt
    setBusy(true)
    setError(null)
    try {
      const kind =
        host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : (providers[host] ?? accounts[host]?.kind)
      if (!kind) throw new Error(t("prefs.chooseProvider"))
      const start = await ipc.oauthDeviceStart(host, clientId, kind, attemptId)
      if (attempt.signal.aborted) {
        cancel()
        return
      }
      setDevice({ host, start })
      await openUrl(start.verificationUriComplete ?? start.verificationUri)

      const outcome = await pollDeviceAuthorization(
        start,
        () => ipc.oauthDevicePoll(host, clientId, start.deviceCode, attemptId),
        attempt.signal
      )
      if (attempt.signal.aborted) return
      if (outcome !== "done") {
        setError(t(outcome === "denied" ? "prefs.authDenied" : "prefs.authExpired"))
      } else {
        await getDesktopRuntime().synchronizeAccounts([host])
        onChanged()
      }
      setDevice(null)
    } catch (e) {
      if (attempt.signal.aborted) return
      setError(String(e))
      setDevice(null)
    } finally {
      cancel()
      attempt.signal.removeEventListener("abort", cancel)
      if (loginAttempt.current === attempt) {
        loginAttempt.current = null
        setBusy(false)
      }
    }
  }

  const sourceLabel = (a: Account) =>
    a.source === "settings"
      ? t("prefs.sourceSettings")
      : a.source === "gitCredential"
        ? t("prefs.sourceGitCredential")
        : a.source === "desktop"
          ? "GitHub Desktop"
          : a.source === "cli"
            ? t("prefs.sourceCli")
            : null

  return (
    <SettingGroup>
      {hosts.map((host, i) => {
        const a: Account = accounts[host] ?? {
          kind: null,
          login: null,
          owners: [],
          source: null,
          ignored: false
        }
        return (
          <div key={host}>
            {i > 0 && <Separator />}
            <SettingRow
              title={
                a.login && !a.ignored && !a.unauthorized ? (
                  <AccountIdentity host={host} account={a} source={sourceLabel(a)} />
                ) : (
                  host
                )
              }
              description={
                a.ignored
                  ? t("prefs.signedOut")
                  : a.unauthorized
                    ? t("prefs.tokenRejected")
                    : a.error
                      ? t("prefs.verifyFailed", { error: a.error })
                      : a.login
                        ? undefined
                        : t("prefs.notSignedIn")
              }>
              {/* 验证失败（断网、服务端出错）时给一个重试入口：网络恢复后不用重启或重新登录。 */}
              {a.error && !a.ignored && !a.unauthorized && (
                <Button size="sm" variant="outline" disabled={busy} onClick={onChanged}>
                  {t("prefs.retry")}
                </Button>
              )}
              {a.login && !a.ignored && !a.unauthorized ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void signOut(host, true)}>
                  {t("prefs.signOut")}
                </Button>
              ) : (clients[host] ?? builtin[host]) ? (
                <>
                  <Button size="sm" disabled={busy} onClick={() => void signIn(host)}>
                    {t("prefs.signInWithOAuth")}
                  </Button>
                  {a.ignored && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void signOut(host, false)}>
                      {t("prefs.reEnable")}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Input
                    type="password"
                    value={draft[host] ?? ""}
                    onChange={e => setDraft(d => ({ ...d, [host]: e.currentTarget.value }))}
                    onBlur={() => draft[host] && void save(host)}
                    placeholder={t("prefs.pasteToken")}
                    className="h-8 w-56 font-mono text-xs placeholder:font-sans"
                  />
                  {a.ignored && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void signOut(host, false)}>
                      {t("prefs.reEnable")}
                    </Button>
                  )}
                </>
              )}
            </SettingRow>

            {/* client_id 不是密钥，设备码流程不需要 client secret。
                每个自建实例的应用都不一样，所以按实例填。 */}
            {/* 有内置应用 ID 的实例（github.com）不用让用户看到这一行 */}
            {/* 服务类型、应用 ID 和「去创建」并排放不下 SettingRow 的右栏，说明会被挤成一列一字：
                用标准 shadcn Field 的纵向布局，说明占整行，控件在下一行按剩余宽度排。 */}
            {!a.login && !builtin[host] && (
              <Field className="gap-2 py-2.5">
                <FieldContent>
                  <FieldTitle className="font-normal">{t("prefs.clientId")}</FieldTitle>
                  <FieldDescription className="text-xs">{t("prefs.clientIdHint", { host })}</FieldDescription>
                </FieldContent>
                <div className="flex items-end gap-2">
                  {host !== "gitlab.com" && (
                    <Select
                      label={t("prefs.provider")}
                      className="w-auto shrink-0"
                      value={providers[host] ?? a.kind ?? ""}
                      onChange={event => {
                        const kind = event.currentTarget.value
                        if (kind === "github" || kind === "gitlab") onSetProvider(host, kind)
                      }}>
                      <option value="" disabled>
                        {t("prefs.chooseProvider")}
                      </option>
                      <option value="github">GitHub Enterprise</option>
                      <option value="gitlab">GitLab</option>
                    </Select>
                  )}
                  <Input
                    aria-label={t("prefs.clientId")}
                    value={clientDraft[host] ?? clients[host] ?? ""}
                    onChange={e => setClientDraft(d => ({ ...d, [host]: e.currentTarget.value }))}
                    onBlur={() => {
                      const v = (clientDraft[host] ?? "").trim()
                      if (v && v !== clients[host]) onSetClient(host, v)
                    }}
                    placeholder="application id"
                    className="h-8 min-w-0 flex-1 font-mono text-xs placeholder:font-sans"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() =>
                      void openUrl(
                        host === "github.com" || providers[host] === "github"
                          ? `https://${host}/settings/applications/new`
                          : `https://${host}/-/user_settings/applications`
                      )
                    }>
                    {t("prefs.createApp")}
                  </Button>
                </div>
              </Field>
            )}

            {device?.host === host && (
              <div className="bg-muted/50 my-2 rounded-md p-3 text-xs">
                <div className="text-muted-foreground">{t("prefs.deviceHint")}</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="font-mono text-lg tracking-widest select-all">{device.start.userCode}</span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    type="button"
                    title={copied ? t("prefs.copied") : t("prefs.copyCode")}
                    aria-label={copied ? t("prefs.copied") : t("prefs.copyCode")}
                    onClick={() =>
                      void navigator.clipboard.writeText(device.start.userCode).then(
                        () => setCopied(true),
                        e => setError(String(e))
                      )
                    }>
                    {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    loginAttempt.current?.abort()
                    setDevice(null)
                    setBusy(false)
                  }}>
                  {t("common.cancel")}
                </Button>
                <StandardButton
                  variant="ghost"
                  type="button"
                  className="text-muted-foreground mt-1 underline underline-offset-2"
                  onClick={() => void openUrl(device.start.verificationUriComplete ?? device.start.verificationUri)}>
                  {device.start.verificationUri}
                </StandardButton>
              </div>
            )}
          </div>
        )
      })}

      <Separator />
      {/* 自建实例：仓库里还没出现过的 host 得自己加一条 */}
      <SettingRow title={t("prefs.addInstance")} description={t("prefs.addInstanceHint")}>
        <Input
          value={newHost}
          onChange={e => setNewHost(e.currentTarget.value)}
          placeholder="gitlab.example.com"
          className="h-8 w-56 text-xs"
        />
        <Button
          size="sm"
          disabled={!newHost.trim()}
          onClick={() => {
            try {
              // 实例标识是 host[:port][/子路径]，接口按 https://<实例>/api/v4 拼。
              const instance = instanceFromURL(new URL(validateURL(newHost)))
              if (!instance) throw new Error(t("prefs.invalidInstance"))
              onAddHost(instance)
              setNewHost("")
              setError(null)
            } catch (failure) {
              setError(String(failure))
            }
          }}>
          {t("prefs.add")}
        </Button>
      </SettingRow>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </SettingGroup>
  )
}

/** 已登录的账号行：Desktop preferences/accounts.tsx renderAccount —— 头像 32px、名字 semibold、`@login`；
 *  非 github.com 的实例按原版 Enterprise 的写法 `@login (名字)` + 实例地址。
 *  `.user-info-container { gap: 10px }`、`.name { margin: -2px 0 }`；凭据来源是本项目的附加说明。 */
function AccountIdentity({ host, account, source }: { host: string; account: Account; source: string | null }) {
  const login = account.login ?? ""
  const name = account.name ?? ""
  const dotCom = host === "github.com"
  return (
    <div className="account-info flex min-w-0 items-center gap-2.5">
      <Avatar>
        <AvatarImage src={account.avatarUrl ?? undefined} alt="" />
        <AvatarFallback>{(name || login).trim().slice(0, 1).toUpperCase() || "?"}</AvatarFallback>
      </Avatar>
      <div className="user-info min-w-0">
        <div className="-my-0.5 truncate font-semibold">
          {dotCom ? name || login : name && name !== login ? `@${login} (${name})` : `@${login}`}
        </div>
        <div className="truncate">{dotCom ? `@${login}` : host}</div>
        {source && <div className="text-muted-foreground text-xs">{source}</div>}
      </div>
    </div>
  )
}

/** Desktop lib/helpers/default-branch.ts：`init.defaultBranch` 没配时按 main */
const DEFAULT_BRANCH_SETTING = "init.defaultBranch"
const DEFAULT_BRANCH = "main"

/** Git 身份。不传 repo 时读写全局配置，并带 Desktop preferences/git.tsx 的「新仓库默认分支」设置。 */
function GitTab() {
  const { t } = useTranslation()
  const [id, setId] = useState({ name: "", email: "" })
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Desktop preferences.tsx 记 initialDefaultBranch，只在值变了才写；RefNameTextBox 把输入清洗成合法引用名，
  // 清洗后不同时提示「将保存为 …」
  const [defaultBranch, setDefaultBranch] = useState<{ initial: string; value: string } | null>(null)
  useEffect(() => {
    let active = true
    setDefaultBranch(null)
    getGlobalConfigValue(DEFAULT_BRANCH_SETTING)
      .then(value => {
        const initial = value ?? DEFAULT_BRANCH
        if (active) setDefaultBranch({ initial, value: initial })
      })
      .catch((e: unknown) => active && setError(String(e)))
    return () => {
      active = false
    }
  }, [])
  const sanitizedDefaultBranch = defaultBranch ? sanitizedRefName(defaultBranch.value) : ""
  const saveDefaultBranch = async () => {
    if (!defaultBranch || !sanitizedDefaultBranch || sanitizedDefaultBranch === defaultBranch.initial) return
    setError(null)
    try {
      await setGlobalConfigValue(DEFAULT_BRANCH_SETTING, sanitizedDefaultBranch)
      setDefaultBranch({ initial: sanitizedDefaultBranch, value: sanitizedDefaultBranch })
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    let active = true
    setReady(false)
    setError(null)
    ipc
      .gitIdentity()
      .then(value => {
        if (active) {
          setId(value)
          setReady(true)
        }
      })
      .catch((e: unknown) => active && setError(String(e)))
    return () => {
      active = false
    }
  }, [])

  // 改了就是改了：失焦即写 git config
  const save = async () => {
    if (!ready) return
    setError(null)
    try {
      if (!gitAuthorNameIsValid(id.name)) throw new Error(InvalidGitAuthorNameMessage)
      await ipc.setGitIdentity(id.name, id.email)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <SettingGroup>
      <SettingRow title={t("prefs.name")}>
        <Input
          disabled={!ready}
          value={id.name}
          aria-label={t("prefs.name")}
          onChange={e => setId({ ...id, name: e.currentTarget.value })}
          onBlur={() => void save()}
          className="h-8 w-56"
        />
      </SettingRow>
      <Separator />
      <SettingRow title={t("prefs.email")} description={t("prefs.globalOnly")}>
        <Input
          disabled={!ready}
          value={id.email}
          aria-label={t("prefs.email")}
          onChange={e => setId({ ...id, email: e.currentTarget.value })}
          onBlur={() => void save()}
          className="h-8 w-56"
        />
      </SettingRow>
      <>
        <Separator />
        <SettingRow
          title={t("prefs.defaultBranch")}
          description={
            <>
              {t("prefs.defaultBranchHint")}
              {defaultBranch && sanitizedDefaultBranch !== defaultBranch.value && (
                <div role="status" className="text-foreground">
                  {t("prefs.defaultBranchWarning", { name: sanitizedDefaultBranch })}
                </div>
              )}
            </>
          }>
          <Input
            disabled={!defaultBranch}
            value={defaultBranch?.value ?? ""}
            aria-label={t("prefs.defaultBranch")}
            onChange={e => defaultBranch && setDefaultBranch({ ...defaultBranch, value: e.currentTarget.value })}
            onBlur={() => void saveDefaultBranch()}
            className="h-8 w-56"
          />
        </SettingRow>
      </>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </SettingGroup>
  )
}

/** 仓库设置：远端地址与 .gitignore。
 *
 * 这两样是「偶尔要改一次、改错了很烦」的东西：远端换了地址、或者要把某个
 * 目录加进忽略列表。放设置里而不是主界面，因为它们不该天天点到。 */
function TrackpadTab({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const { t } = useTranslation()
  const available = useTrackpadAvailability()
  return (
    <SettingGroup>
      <SettingRow
        title={t("prefs.canvasTrackpad")}
        description={available === false ? t("prefs.noTrackpad") : undefined}>
        <Switch
          checked={available === true && enabled}
          disabled={available !== true}
          onCheckedChange={onChange}
          aria-label={t("prefs.canvasTrackpad")}
        />
      </SettingRow>
    </SettingGroup>
  )
}

function AppearanceTab({ theme, onChange }: { theme: string; onChange: (theme: string) => void }) {
  const { t } = useTranslation()
  return (
    <SettingGroup>
      <SettingRow title={t("prefs.theme")}>
        <ToggleGroup
          value={[theme]}
          onValueChange={values => {
            if (values.length) onChange(values[0])
          }}
          variant="outline"
          size="sm"
          aria-label={t("prefs.theme")}>
          {["light", "dark", "system"].map(v => (
            <ToggleGroupItem key={v} value={v}>
              {t(`prefs.theme_${v}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
    </SettingGroup>
  )
}

function AdvancedTab({ language, onChange }: { language: string; onChange: (l: string) => void }) {
  const { t } = useTranslation()
  const options = [
    { id: "", label: t("prefs.lang_system") },
    { id: "zh-CN", label: "简体中文" },
    { id: "en", label: "English" }
  ]
  return (
    <SettingGroup>
      <SettingRow title={t("prefs.language")} description={t("prefs.languageHint")}>
        <ToggleGroup
          value={[language || "system"]}
          onValueChange={values => {
            if (!values.length) return
            const value = values[0] === "system" ? "" : values[0]
            onChange(value)
            void i18n.changeLanguage(value || undefined)
          }}
          variant="outline"
          size="sm"
          aria-label={t("prefs.language")}>
          {options.map(o => (
            <ToggleGroupItem key={o.id} value={o.id || "system"}>
              {o.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
    </SettingGroup>
  )
}

function IntegrationSettings({ state, onPatch }: { state: AppState; onPatch: (patch: Partial<AppState>) => void }) {
  const { t } = useTranslation()
  const [apps, setApps] = useState<Awaited<ReturnType<typeof ipc.availableIntegrations>>>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void ipc
      .availableIntegrations()
      .then(apps => active && setApps(apps))
      .catch(e => active && setError(String(e)))
    return () => {
      active = false
    }
  }, [])
  return (
    <SettingGroup>
      {(["editor", "terminal"] as const).map(kind => {
        const field = kind === "editor" ? "externalEditor" : "externalTerminal"
        const value = state[field] ?? ""
        return (
          <SettingRow key={kind} title={t(`prefs.${field}`)}>
            <Select
              ariaLabel={t(`prefs.${field}`)}
              value={value}
              onChange={e => onPatch({ [field]: e.currentTarget.value })}>
              <option value="">{t("prefs.systemDefault")}</option>
              {value && !apps.some(app => app.bundleId === value) && <option value={value}>{value}</option>}
              {apps
                .filter(app => app.kind === kind)
                .map(app => (
                  <option key={app.bundleId} value={app.bundleId}>
                    {app.name}
                  </option>
                ))}
            </Select>
          </SettingRow>
        )
      })}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </SettingGroup>
  )
}

function DesktopImportSettings({ state, onPatch }: { state: AppState; onPatch: (patch: Partial<AppState>) => void }) {
  const { t } = useTranslation()
  const current = useRef(state)
  current.current = state
  const importing = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const importDesktop = async () => {
    if (importing.current) return
    importing.current = true
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const data = await ipc.readDesktopImport()
      const previous = current.current
      const repositories = [...new Set([...previous.repositories, ...data.repositories])]
      const patch: Partial<AppState> = {
        repositories,
        accountHosts: [...new Set([...previous.accountHosts, ...(data.accountHosts ?? [])])],
        desktopImportHandled: true
      }
      if (!previous.selectedRepository) patch.selectedRepository = data.selectedRepository ?? repositories[0] ?? null
      if (data.theme !== null) patch.theme = data.theme
      if (data.sidebarWidth !== null) patch.sidebarWidth = data.sidebarWidth
      if (data.externalEditor !== null) patch.externalEditor = data.externalEditor
      if (data.externalTerminal !== null) patch.externalTerminal = data.externalTerminal
      onPatch(patch)
      setMessage(
        t("prefs.desktopImported", {
          count: repositories.length - previous.repositories.length,
          skipped: data.skipped.length
        })
      )
    } catch (e) {
      setError(String(e))
    } finally {
      importing.current = false
      setBusy(false)
    }
  }
  return (
    <SettingGroup>
      <SettingRow title={t("prefs.desktopImport")} description={t("prefs.desktopImportHint")}>
        <Button variant="outline" disabled={busy} onClick={() => void importDesktop()}>
          {t(busy ? "prefs.desktopImporting" : "prefs.desktopImportAction")}
        </Button>
      </SettingRow>
      {message && (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </SettingGroup>
  )
}
