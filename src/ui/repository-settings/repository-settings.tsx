import { FileIcon, GitCommitIcon, ServerIcon, TrashIcon } from "@primer/octicons-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  addRemote,
  getConfigValue,
  getGlobalConfigValue,
  getRemotes,
  removeConfigValue,
  removeRemote,
  setConfigValue,
  setRemoteURL
} from "@/lib/desktop-git"
import { ipc } from "@/lib/ipc"
import { Repository } from "@/models/repository"
import { Button } from "@/ui/base/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/base/dialog"
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/ui/base/field"
import { Input } from "@/ui/base/input"
import { RadioGroup, RadioGroupItem } from "@/ui/base/radio-group"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/base/tabs"
import { Textarea } from "@/ui/base/textarea"
import type { IRemote } from "@/upstream/models/remote"
import { gitAuthorNameIsValid, InvalidGitAuthorNameMessage } from "@/upstream/ui/lib/identifier-rules"

import { NoRemote } from "./no-remote"

/** Desktop repository-settings.tsx RepositorySettingsTab。Fork Behavior 本项目没有对应的贡献目标设置，不列 */
const TABS = ["remote", "ignoredFiles", "gitConfig"] as const
type Tab = (typeof TABS)[number]
const TAB_ICONS = { remote: ServerIcon, ignoredFiles: FileIcon, gitConfig: GitCommitIcon }

type GitConfigLocation = "global" | "local"

interface Loaded {
  remotes: IRemote[]
  ignoreText: string | null
  location: GitConfigLocation
  localName: string | null
  localEmail: string | null
  globalName: string
  globalEmail: string
}

/** Desktop RepositorySettings：各页签只改本地状态，点「保存」才按原版 onSubmit 的顺序写入
 *  （远端 URL → .gitignore → 本地 Git 身份），出错的留在对话框里，全部成功才关闭。 */
export function RepositorySettings({
  repo,
  primaryRemote,
  onDismissed,
  onPublish
}: {
  repo: string
  /** Desktop gitStore.currentRemote：当前分支跟踪的远端，否则 origin */
  primaryRemote: string | null
  onDismissed: () => void
  onPublish: () => void
}) {
  const { t } = useTranslation()
  const repository = new Repository(repo, -1, null, false)
  const [tab, setTab] = useState<Tab>("remote")
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null)
  const [ignoreText, setIgnoreText] = useState<string | null>(null)
  const [location, setLocation] = useState<GitConfigLocation>("global")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [errors, setErrors] = useState<string[]>([])
  const [disabled, setDisabled] = useState(false)
  const [newRemote, setNewRemote] = useState({ name: "", url: "" })

  const load = async () => {
    const [remotes, localName, localEmail, globalName, globalEmail] = await Promise.all([
      getRemotes(repository),
      getConfigValue(repository, "user.name", true),
      getConfigValue(repository, "user.email", true),
      getGlobalConfigValue("user.name"),
      getGlobalConfigValue("user.email")
    ])
    let ignore: string | null = null
    const failures: string[] = []
    try {
      ignore = await ipc.readGitignore(repo)
    } catch (e) {
      failures.push(t("repositorySettings.couldNotReadRootGitignore", { error: String(e) }))
    }
    const location: GitConfigLocation = localName === null && localEmail === null ? "global" : "local"
    return {
      loaded: {
        remotes,
        ignoreText: ignore,
        location,
        localName,
        localEmail,
        globalName: globalName ?? "",
        globalEmail: globalEmail ?? ""
      },
      failures
    }
  }

  useEffect(() => {
    let active = true
    void load()
      .then(({ loaded, failures }) => {
        if (!active) return
        const primary = loaded.remotes.find(r => r.name === (primaryRemote ?? "origin")) ?? null
        setLoaded(loaded)
        setRemoteUrl(primary?.url ?? null)
        setIgnoreText(loaded.ignoreText)
        setLocation(loaded.location)
        setName(loaded.location === "local" ? (loaded.localName ?? "") : loaded.globalName)
        setEmail(loaded.location === "local" ? (loaded.localEmail ?? "") : loaded.globalEmail)
        setErrors(failures)
      })
      .catch((e: unknown) => active && setErrors([String(e)]))
    return () => {
      active = false
    }
    // 只在打开时读一次：之后的编辑都是对话框内的草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo])

  const primary = loaded?.remotes.find(r => r.name === (primaryRemote ?? "origin")) ?? null
  const others = loaded?.remotes.filter(r => r !== primary) ?? []
  const nameInvalid = location === "local" && !gitAuthorNameIsValid(name)

  const reloadRemotes = async () => {
    const remotes = await getRemotes(repository)
    setLoaded(previous => (previous ? { ...previous, remotes } : previous))
  }

  const save = async () => {
    if (!loaded) return
    setDisabled(true)
    setErrors([])
    const failures: string[] = []
    if (primary && remoteUrl !== null) {
      const trimmed = remoteUrl.trim()
      if (trimmed !== primary.url) {
        try {
          await setRemoteURL(repository, primary.name, trimmed)
        } catch (e) {
          failures.push(t("repositorySettings.failedSettingTheRemoteUrl", { error: String(e) }))
        }
      }
    }
    if (ignoreText !== null && ignoreText !== loaded.ignoreText) {
      try {
        await ipc.writeGitignore(repo, ignoreText)
      } catch (e) {
        failures.push(t("repositorySettings.failedSavingTheGitignoreFile", { error: String(e) }))
      }
    }
    try {
      if (location !== loaded.location && location === "global") {
        await removeConfigValue(repository, "user.name")
        await removeConfigValue(repository, "user.email")
      } else if (location === "local") {
        if (name !== loaded.localName) await setConfigValue(repository, "user.name", name)
        if (email !== loaded.localEmail) await setConfigValue(repository, "user.email", email)
      }
    } catch (e) {
      failures.push(String(e))
    }
    if (failures.length === 0) onDismissed()
    else {
      setErrors(failures)
      setDisabled(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => !open && onDismissed()}>
      <DialogContent className="h-[520px] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <Tabs
          orientation="vertical"
          value={tab}
          onValueChange={value => TABS.includes(value) && setTab(value)}
          className="h-full min-h-0 gap-0">
          <TabsList
            aria-label={t("repositorySettings.title")}
            className="w-44 shrink-0 items-stretch justify-start gap-0.5 rounded-none border-r bg-transparent px-3 py-4 group-data-vertical/tabs:h-full">
            {TABS.map(id => {
              const Icon = TAB_ICONS[id]
              return (
                <TabsTrigger key={id} value={id} className="h-9 flex-none justify-start gap-2 px-3">
                  <Icon data-icon="inline-start" size={16} />
                  <span>{t(`repositorySettings.${id}`)}</span>
                </TabsTrigger>
              )
            })}
          </TabsList>
          <form
            className="flex min-w-0 flex-1 flex-col"
            onSubmit={event => {
              event.preventDefault()
              void save()
            }}>
            <DialogHeader className="py-4 pr-12 pl-4">
              <DialogTitle>{t("repositorySettings.title")}</DialogTitle>
            </DialogHeader>
            {errors.map(error => (
              <p key={error} role="alert" className="text-destructive px-4 pb-2 text-xs">
                {error}
              </p>
            ))}
            {nameInvalid && <p className="text-destructive px-4 pb-2 text-xs">{InvalidGitAuthorNameMessage}</p>}

            <TabsContent value="remote" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              {loaded &&
                (primary ? (
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="primary-remote-url">
                        {t("repositorySettings.primaryRemoteRepositoryUrl", { name: primary.name })}
                      </FieldLabel>
                      <Input
                        id="primary-remote-url"
                        placeholder={t("repositorySettings.remoteUrl")}
                        value={remoteUrl ?? ""}
                        onChange={event => setRemoteUrl(event.currentTarget.value)}
                        className="font-mono text-xs"
                      />
                    </Field>
                    {/* 本项目独有：其他远端（PR／MR 检出时也会加），增删立即生效 */}
                    <FieldSet>
                      <FieldLegend variant="label">{t("repositorySettings.otherRemotes")}</FieldLegend>
                      {others.map(remote => (
                        <Field key={remote.name} orientation="horizontal">
                          <span className="w-20 shrink-0 truncate text-sm">{remote.name}</span>
                          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
                            {remote.url}
                          </span>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t("prefs.removeRemote")}
                            title={t("prefs.removeRemote")}
                            onClick={() =>
                              void removeRemote(repository, remote.name)
                                .then(reloadRemotes)
                                .catch(e => setErrors([String(e)]))
                            }>
                            <TrashIcon size={14} />
                          </Button>
                        </Field>
                      ))}
                      <Field orientation="horizontal">
                        <Input
                          aria-label={t("prefs.remoteName")}
                          placeholder={t("prefs.remoteName")}
                          className="w-28"
                          value={newRemote.name}
                          onChange={e => setNewRemote({ ...newRemote, name: e.currentTarget.value })}
                        />
                        <Input
                          aria-label={t("prefs.remoteUrl")}
                          placeholder="https://…"
                          className="min-w-0 flex-1"
                          value={newRemote.url}
                          onChange={e => setNewRemote({ ...newRemote, url: e.currentTarget.value })}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            !newRemote.name.trim() ||
                            !newRemote.url.trim() ||
                            loaded.remotes.some(r => r.name === newRemote.name.trim())
                          }
                          onClick={() =>
                            void addRemote(repository, newRemote.name.trim(), newRemote.url.trim())
                              .then(() => {
                                setNewRemote({ name: "", url: "" })
                                return reloadRemotes()
                              })
                              .catch(e => setErrors([String(e)]))
                          }>
                          {t("prefs.addRemote")}
                        </Button>
                      </Field>
                    </FieldSet>
                  </FieldGroup>
                ) : (
                  <NoRemote onPublish={onPublish} />
                ))}
            </TabsContent>

            <TabsContent value="ignoredFiles" className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4">
              <DialogDescription id="ignored-files-description">
                {t("repositorySettings.editingGitignore")}{" "}
                <button
                  type="button"
                  className="text-primary underline-offset-4 hover:underline"
                  onClick={() => void openUrl("https://git-scm.com/docs/gitignore")}>
                  {t("repositorySettings.learnMoreAboutGitignoreFiles")}
                </button>
              </DialogDescription>
              <Textarea
                aria-label={t("repositorySettings.ignoredFiles")}
                aria-describedby="ignored-files-description"
                placeholder={t("repositorySettings.ignoredFiles")}
                disabled={!loaded || ignoreText === null}
                value={ignoreText ?? ""}
                onChange={event => setIgnoreText(event.currentTarget.value)}
                className="min-h-0 flex-1 resize-none font-mono text-xs"
              />
            </TabsContent>

            <TabsContent value="gitConfig" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <FieldGroup>
                <FieldSet>
                  <FieldLegend id="git-config-heading">{t("repositorySettings.forThisRepositoryIWishTo")}</FieldLegend>
                  <RadioGroup
                    aria-labelledby="git-config-heading"
                    value={location}
                    disabled={!loaded}
                    onValueChange={value => {
                      if (!loaded) return
                      const next = value as GitConfigLocation
                      setLocation(next)
                      // Desktop GitConfig：全局时显示全局值（只读），本地时编辑本地草稿
                      setName(next === "local" ? (loaded.localName ?? loaded.globalName) : loaded.globalName)
                      setEmail(next === "local" ? (loaded.localEmail ?? loaded.globalEmail) : loaded.globalEmail)
                    }}>
                    {(["global", "local"] as const).map(option => (
                      <Field key={option} orientation="horizontal">
                        <RadioGroupItem id={`git-config-${option}`} value={option} />
                        <FieldLabel htmlFor={`git-config-${option}`} className="font-normal">
                          {t(
                            option === "global"
                              ? "repositorySettings.useMyGlobalGitConfig"
                              : "repositorySettings.useALocalGitConfig"
                          )}
                        </FieldLabel>
                      </Field>
                    ))}
                  </RadioGroup>
                </FieldSet>
                <Field>
                  <FieldLabel htmlFor="git-config-name">{t("prefs.name")}</FieldLabel>
                  <Input
                    id="git-config-name"
                    disabled={!loaded || location === "global"}
                    value={name}
                    onChange={event => setName(event.currentTarget.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="git-config-email">{t("prefs.email")}</FieldLabel>
                  <Input
                    id="git-config-email"
                    type="email"
                    disabled={!loaded || location === "global"}
                    value={email}
                    onChange={event => setEmail(event.currentTarget.value)}
                  />
                </Field>
              </FieldGroup>
            </TabsContent>

            <DialogFooter className="mt-auto px-4 pb-4">
              <Button type="button" variant="outline" onClick={onDismissed}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!loaded || disabled || nameInvalid}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
