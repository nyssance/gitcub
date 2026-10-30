import { isTauri } from "@tauri-apps/api/core"
import equal from "deep-equal"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { type IMenu, menuFromElectronMenu } from "@/models/app-menu"
import { Repository } from "@/models/repository"

import { getRemoteHEAD } from "../desktop-git"
import { contributesToParent, contributionRepository } from "../fork-contribution"
import { ipc } from "../ipc"
import { sameHostedRepository } from "../pull-request-checkout"
import { buildDefaultMenuTemplate } from "./build-default-menu"
import { type MenuTemplate, updateNativeMenu } from "./native-menu"
import { type NativeMenuContext, repositoryMenuState } from "./repository-menu-state"
import { snapshotMenu } from "./snapshot"

export function useNativeMenu(context: NativeMenuContext) {
  const { state, status, busy, remote, stashesVisible, filterVisible, hasStashes, platform } = context
  // 调用方每次渲染都传一个新的 context 对象；菜单只随这些字段变，不随对象身份变。
  // 2026-10-30：下面的 effect 曾直接依赖 context，而它里面的 setAppMenu 每次都放新对象，
  // 任何一次 App 重渲染都会再触发一次 effect → 再 setAppMenu → 再渲染，PR 列表一有行就把页面卡死。
  const menuContext = useMemo<NativeMenuContext>(
    () => ({ state, status, busy, remote, stashesVisible, filterVisible, hasStashes, platform }),
    [state, status, busy, remote, stashesVisible, filterVisible, hasStashes, platform]
  )
  const { i18n, t } = useTranslation()
  const [integrations, setIntegrations] = useState<Awaited<ReturnType<typeof ipc.availableIntegrations>>>([])
  // refresh installed app names after changing integration preferences.
  useEffect(() => {
    if (isTauri())
      void ipc
        .availableIntegrations()
        .then(setIntegrations)
        .catch(error => log.warn("Unable to load menu integrations", String(error)))
  }, [state?.externalEditor, state?.externalTerminal])
  const editorName = integrations.find(app => app.bundleId === state?.externalEditor)?.name ?? state?.externalEditor
  const shellName = integrations.find(app => app.bundleId === state?.externalTerminal)?.name ?? state?.externalTerminal
  const repo = state?.selectedRepository
  const [defaultBranch, setDefaultBranch] = useState<string>()
  const [hasCurrentPullRequest, setHasCurrentPullRequest] = useState(false)
  // Desktop AppMenu 模型：空白页的建议动作按菜单 id 找标签、快捷键和可用性
  const [appMenu, setAppMenu] = useState<IMenu>()
  useEffect(() => {
    let active = true
    setDefaultBranch(undefined)
    setHasCurrentPullRequest(false)
    if (!repo) return
    void (async () => {
      const remotes = await ipc.remotes(repo)
      // Desktop findContributionTargetDefaultBranch：只有为上游贡献时才用 upstream 的默认分支
      const upstream = (await contributesToParent(repo))
        ? remotes.find(([name]) => name === "upstream")?.[0]
        : undefined
      const name = upstream ?? status.remote ?? remotes[0]?.[0]
      if (name) {
        const branch = await getRemoteHEAD(new Repository(repo, -1, null, false), name)
        if (active) setDefaultBranch(branch ?? undefined)
      }
      if (remote && status.branch) {
        const target = await contributionRepository(repo, remote)
        const prs = await ipc.pullRequests(target.host, target.owner, target.name, true)
        const details = (await ipc.branchDetails(repo, `refs/heads/${status.branch}`))[0]
        const head = details?.upstreamWithoutRemote ?? status.branch
        const sourceRemote =
          remotes.find(([name]) => name === details?.upstreamRemoteName) ??
          remotes.find(([name]) => name === "origin") ??
          remotes[0]
        const sourceRepository = sourceRemote
          ? await ipc.parseRemote(await ipc.remotePushUrl(repo, sourceRemote[0]))
          : null
        let found = false
        for (const pr of prs.filter(pr => pr.head === head)) {
          const source = await ipc.pullRequestSource(target.host, target.owner, target.name, pr.number)
          if (sameHostedRepository(sourceRepository, await ipc.parseRemote(source.cloneUrl))) {
            found = true
            break
          }
        }
        if (active) setHasCurrentPullRequest(found)
      }
    })().catch(error => log.warn("Unable to refresh native menu metadata", String(error)))
    return () => {
      active = false
    }
  }, [repo, status.branch, status.remote, remote])
  useEffect(() => {
    if (!isTauri()) return
    const templates = buildDefaultMenuTemplate({
      selectedExternalEditor: editorName || null,
      selectedShell: shellName || null,
      askForConfirmationOnForcePush: true,
      askForConfirmationOnRepositoryRemoval: true,
      askForConfirmationWhenStashingAllChanges: false,
      isStashedChangesVisible: stashesVisible,
      isChangesFilterVisible: filterVisible,
      contributionTargetDefaultBranch: defaultBranch,
      hasCurrentPullRequest,
      isForcePushForCurrentRepository: status.hasUpstream && status.ahead > 0 && status.behind > 0
    })
    const enabled = repositoryMenuState(menuContext, defaultBranch)
    const apply = (items: MenuTemplate[]) => {
      for (const item of items) {
        if (item.id && item.id in enabled) item.enabled = enabled[item.id]
        if (!item.label && ["help", "windowMenu"].includes(item.role ?? ""))
          item.label = item.role === "help" ? "Help" : "Window"
        if (item.label) {
          // Keep upstream templates untouched; translate only native presentation.
          const key = `nativeMenu.${item.label.replaceAll("&", "")}`
          if (i18n.exists(key)) item.label = t(key)
          if (item.id === "open-in-shell")
            item.label = t("nativeMenu.openIn", { name: shellName || t("nativeMenu.shell") })
          if (item.id === "open-external-editor")
            item.label = t("nativeMenu.openIn", { name: editorName || t("nativeMenu.editor") })
          if (item.id === "update-branch-with-contribution-target-branch")
            item.label = t("nativeMenu.updateFrom", { name: defaultBranch || t("nativeMenu.defaultBranch") })
          if (
            platform === "gitlab" &&
            [
              "view-repository-on-github",
              "create-issue-in-repository-on-github",
              "compare-on-github",
              "branch-on-github",
              "create-pull-request",
              "preview-pull-request"
            ].includes(item.id ?? "")
          )
            item.label = item.label
              .replaceAll("GitHub", "GitLab")
              .replaceAll("Pull Request", "Merge Request")
              .replaceAll("拉取请求", "合并请求")
        }
        if (item.submenu) apply(item.submenu)
      }
    }
    apply(templates)
    try {
      const next = menuFromElectronMenu(snapshotMenu(templates))
      // 内容没变就不换对象：换了会让 App 重渲染，空白页建议动作也跟着重算
      setAppMenu(previous => (equal(previous, next) ? previous : next))
    } catch (error) {
      log.error("Unable to build the app menu model", error)
    }
    void updateNativeMenu(templates).catch(error => log.error("Unable to update native menu", error))
  }, [
    menuContext,
    status,
    stashesVisible,
    filterVisible,
    defaultBranch,
    hasCurrentPullRequest,
    platform,
    i18n,
    t,
    editorName,
    shellName
  ])
  // 设置里选的编辑器名：改动行右键菜单的「用 … 打开」和原生菜单用同一个；
  // 菜单模型、默认分支和「当前分支已有 PR」给空白页的建议动作
  return { editorName: editorName || null, appMenu, defaultBranch: defaultBranch ?? null, hasCurrentPullRequest }
}
