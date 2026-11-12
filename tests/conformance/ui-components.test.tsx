// 自有回归：Storybook 不再做交互断言（2026-11-02）后，组件层的行为——调哪个原生命令、带什么参数、
// 失败后能否重试、确认前不写、忙时锁住——在这里用 jsdom + Testing Library 渲染真实组件验证。
// 用例照删掉的 stories play 移植（同名 story 写在用例标题里），原生命令由 native-fixtures 替身应答。
// run.ts 给 .tsx 套件预先载入 react-environment.ts（RTL 的 act 设置）。
import { afterEach, expect, mock, test } from "bun:test"

import * as matchers from "@testing-library/jest-dom/matchers"
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { type ComponentProps, useRef, useState } from "react"

import { mockTrendingBrowser, mockTrendingWebview } from "../../.storybook/mocks/trending"
import { useEmojiStore } from "../../src/features/emoji/store"
import { usePullRequestsStore } from "../../src/features/pull-requests/store"
import { APICheckConclusion, APICheckStatus, type IAPIWorkflowJobStep } from "../../src/lib/api"
import { autolinkRefSets } from "../../src/lib/autolink-rules"
import type { IRefCheck } from "../../src/lib/ci-checks/ci-checks"
import { canDropCommits, takeCommitDrag } from "../../src/lib/commit-drag"
import type { IMentionableUser } from "../../src/lib/databases/github-user-database"
import { initialSelection } from "../../src/lib/diff"
import i18n from "../../src/lib/i18n"
import { completionRepository, mentionableUsersSource } from "../../src/lib/mentionable-users"
import { routes } from "../../src/lib/navigate"
import type { PullRequestTargets } from "../../src/lib/pull-request-navigation"
import { readEmoji } from "../../src/lib/read-emoji"
import type { CheckRun, ImageDiff, PullRequest } from "../../src/models/app-state"
import type { CommitFile, SearchQuery } from "../../src/models/history"
import { EmojiAutocompletionProvider } from "../../src/ui/autocompletion/emoji-autocompletion-provider"
import { AutocompletingTextArea } from "../../src/ui/autocompletion/inputs"
import {
  CoAuthorAutocompletionProvider,
  UserAutocompletionProvider
} from "../../src/ui/autocompletion/user-autocompletion-provider"
import { Blame } from "../../src/ui/blame/blame"
import { Banner } from "../../src/ui/changes/banner"
import { Conflicts } from "../../src/ui/changes/conflicts"
import { ChangesFileList } from "../../src/ui/changes/file-list"
import { Stashes } from "../../src/ui/changes/stashes"
import { CICheckRunActionsJobStepList } from "../../src/ui/check-runs/ci-check-run-actions-job-step-list"
import { CICheckRunList } from "../../src/ui/check-runs/ci-check-run-list"
import { Grid, type GridImperativeAPI } from "../../src/ui/desktop/list/virtualized-grid"
import { RichText } from "../../src/ui/desktop/rich-text"
import { DiffView, ImagePane } from "../../src/ui/diff/diff"
import { ImageDiffView } from "../../src/ui/diff/image"
import { SplitDiff } from "../../src/ui/diff/split-diff"
import { SubmoduleView } from "../../src/ui/diff/submodule"
import { CommitSummary } from "../../src/ui/history/commit-summary"
import { CommitFileList } from "../../src/ui/history/file-list"
import { HistorySidebar } from "../../src/ui/history/sidebar"
import { Tags } from "../../src/ui/history/tags"
import { Inbox } from "../../src/ui/inbox/inbox"
import { AutolinkRules } from "../../src/ui/preferences/autolink-rules"
import { Preferences } from "../../src/ui/preferences/preferences"
import { CreatePullRequest } from "../../src/ui/pull-requests/create"
import { PullRequests } from "../../src/ui/pull-requests/list"
import { RepositorySettings } from "../../src/ui/repository-settings/repository-settings"
import { RepositoryRail } from "../../src/ui/repository/repository-rail"
import { BranchDropdown } from "../../src/ui/toolbar/branch-dropdown"
import { Discover } from "../../src/ui/trending/discover"
import { Trending } from "../../src/ui/trending/trending"
import { UnknownAuthors } from "../../src/ui/unknown-authors/unknown-authors-dialog"
import { DesktopImportWelcome } from "../../src/ui/welcome/desktop-import"
import { Worktrees } from "../../src/ui/worktrees/worktrees"
import { DiffParser } from "../../src/upstream/lib/diff-parser"
import { DiffSelection, DiffSelectionType } from "../../src/upstream/models/diff"
import { commit, file, repo, status as repoStatus, summary } from "../../stories/fixtures"
import { callsOf, installNativeFixtures, nativeCall, pending, unavailable } from "./native-fixtures"
import { openedUrls } from "./opener"

// bun 自带 toBeEmpty，与 jest-dom 的签名不同，去掉这一项再合并
declare module "bun:test" {
  // eslint-disable-next-line typescript/no-empty-object-type -- 模块扩充只能用 interface 合并
  interface Matchers<T> extends Omit<TestingLibraryMatchers<typeof expect.stringContaining, T>, "toBeEmpty"> {}
}
expect.extend(matchers)
// jsdom 的 addEventListener 只认它自己的 AbortSignal（菜单用 signal 解绑监听），也没有 scrollIntoView / scrollTo
Object.assign(globalThis, { AbortController: window.AbortController, AbortSignal: window.AbortSignal })
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.scrollTo ??= () => {}
// motion / Base UI 等动画结束时会查 getAnimations；jsdom 没有 Web Animations，视为没有进行中的动画
Element.prototype.getAnimations ??= () => []
// shadcn Sidebar 用 matchMedia 判断移动端；按桌面宽度回答不匹配
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false
  }) as MediaQueryList
void i18n.changeLanguage("en")
let uninstall = () => {}
let unlayout = () => {}
/** 虚拟列表（AutoSizer、SectionList）靠 ResizeObserver 和元素尺寸决定渲染哪些行；jsdom 没有布局，
 *  给所有元素一个固定视口大小，观察时立刻回报一次 */
function layout(width = 365, height = 384) {
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() {} })
  const original = {
    rect: Element.prototype.getBoundingClientRect,
    ResizeObserver: window.ResizeObserver,
    sizes: Object.fromEntries(
      (["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const).map(key => [
        key,
        Object.getOwnPropertyDescriptor(key.startsWith("offset") ? HTMLElement.prototype : Element.prototype, key)!
      ])
    )
  }
  const sized = (key: string, value: number) =>
    Object.defineProperty(key.startsWith("offset") ? HTMLElement.prototype : Element.prototype, key, {
      configurable: true,
      get: () => value
    })
  Element.prototype.getBoundingClientRect = rect as never
  for (const key of ["offsetWidth", "clientWidth"]) sized(key, width)
  for (const key of ["offsetHeight", "clientHeight"]) sized(key, height)
  const Observer = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      setTimeout(() => this.callback([{ target, contentRect: rect() } as never], this as never), 0)
    }
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = globalThis.ResizeObserver = Observer as never
  unlayout = () => {
    Element.prototype.getBoundingClientRect = original.rect
    window.ResizeObserver = globalThis.ResizeObserver = original.ResizeObserver
    for (const [key, descriptor] of Object.entries(original.sizes))
      Object.defineProperty(key.startsWith("offset") ? HTMLElement.prototype : Element.prototype, key, descriptor)
    unlayout = () => {}
  }
}
const fixtures = (overrides: Parameters<typeof installNativeFixtures>[0] = {}) =>
  (uninstall = installNativeFixtures(overrides))
afterEach(() => {
  cleanup()
  unlayout()
  uninstall()
  uninstall = () => {}
})
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options ?? {})

test("autolink preferences emit only rules that pass validation, and removal emits the rest", async () => {
  const user = userEvent.setup()
  const emitted: unknown[] = []
  const { rerender } = render(<AutolinkRules rules={[]} onChange={rules => emitted.push(rules)} />)
  await user.click(screen.getByRole("button", { name: t("prefs.autolinkAdd") }))
  expect(emitted.at(-1)).toEqual([])
  await user.type(screen.getByLabelText(t("prefs.autolinkPrefix")), "JIRA-")
  expect(emitted.at(-1)).toEqual([])
  await user.type(screen.getByLabelText(t("prefs.autolinkUrl")), "https://jira.example.com/browse/JIRA-<num>")
  expect(emitted.at(-1)).toMatchObject([{ prefix: "JIRA-", url: "https://jira.example.com/browse/JIRA-<num>" }])
  rerender(<AutolinkRules rules={emitted.at(-1) as never} onChange={rules => emitted.push(rules)} />)
  await user.click(screen.getByRole("button", { name: t("prefs.autolinkRemove") }))
  expect(emitted.at(-1)).toEqual([])
})

// ---- Changes/Conflict resolution ----
const conflicted = { ...file, change: "conflicted" as const }
function conflicts(props: Partial<Parameters<typeof Conflicts>[0]> = {}) {
  const args = {
    operation: "merge" as const,
    files: [conflicted],
    ours: "main",
    theirs: "feature/topic",
    onResolve: mock(),
    onAbort: mock(),
    onContinue: mock(),
    ...props
  }
  render(<Conflicts {...(args as Parameters<typeof Conflicts>[0])} />)
  return args
}
test("conflicts: Continue stays disabled while unresolved; keeping a side resolves ours/theirs (UnresolvedMerge, KeepIncoming)", async () => {
  const user = userEvent.setup()
  const args = conflicts()
  expect(screen.getByRole("button", { name: t("conflicts.continue.merge") })).toBeDisabled()
  await user.click(screen.getByRole("button", { name: t("conflicts.keep", { branch: "main" }) }))
  expect(args.onResolve).toHaveBeenLastCalledWith(conflicted, "ours")
  await user.click(screen.getByRole("button", { name: t("conflicts.keep", { branch: "feature/topic" }) }))
  expect(args.onResolve).toHaveBeenLastCalledWith(conflicted, "theirs")
  expect(args.onContinue).not.toHaveBeenCalled()
})
test("conflicts: rebase maps base to ours and the replayed commit to theirs (RebaseSides, AbortRebase)", async () => {
  const user = userEvent.setup()
  const args = conflicts({ operation: "rebase" })
  await user.click(screen.getByRole("button", { name: t("conflicts.keep", { branch: t("conflicts.rebaseBase") }) }))
  expect(args.onResolve).toHaveBeenLastCalledWith(conflicted, "ours")
  await user.click(screen.getByRole("button", { name: t("conflicts.keep", { branch: t("conflicts.rebaseCommit") }) }))
  expect(args.onResolve).toHaveBeenLastCalledWith(conflicted, "theirs")
  await user.click(screen.getByRole("button", { name: t("conflicts.abort") }))
  expect(args.onAbort).toHaveBeenCalledWith("rebase")
})
test("conflicts: modify/delete drops the deleting side as theirs (ModifyDelete)", async () => {
  const user = userEvent.setup()
  const deleted = {
    ...conflicted,
    conflict: { hasBase: true, hasOurs: true, hasTheirs: false, markers: 0, binary: false }
  }
  const args = conflicts({ files: [deleted] })
  await user.click(screen.getByRole("button", { name: t("conflicts.drop", { branch: "feature/topic" }) }))
  expect(args.onResolve).toHaveBeenCalledWith(deleted, "theirs")
  expect(screen.getByRole("button", { name: t("conflicts.continue.merge") })).toBeDisabled()
})
test("conflicts: Continue passes the operation once everything is resolved (ResolvedMerge/Rebase/CherryPick/Revert)", async () => {
  const user = userEvent.setup()
  for (const operation of ["merge", "rebase", "cherry-pick", "revert"] as const) {
    const args = conflicts({ operation, files: [] })
    await user.click(screen.getByRole("button", { name: t(`conflicts.continue.${operation}`) }))
    expect(args.onContinue).toHaveBeenCalledWith(operation)
    cleanup()
  }
  conflicts({ operation: null })
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
})
test("conflicts: busy disables every action (BusyPreventsRepeatedOperations)", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  const args = conflicts({ busy: true })
  for (const button of screen.getAllByRole("button")) {
    expect(button).toBeDisabled()
    await user.click(button)
  }
  expect(args.onResolve).not.toHaveBeenCalled()
  expect(args.onAbort).not.toHaveBeenCalled()
  expect(args.onContinue).not.toHaveBeenCalled()
})

// ---- Changes/Stashes ----
test("stashes: pop and drop pass their own stash name and not the other action (Restore, Discard, Empty)", async () => {
  const user = userEvent.setup()
  const manual = { sha: "a".repeat(40), name: "stash@{0}", message: "WIP: preserve local changes", ours: false }
  const onPop = mock()
  const onDrop = mock()
  const stashes = [manual, { sha: "b".repeat(40), name: "stash@{1}", message: "!!GitCub<feature/topic>", ours: true }]
  const { rerender } = render(<Stashes stashes={stashes} onPop={onPop} onDrop={onDrop} />)
  const first = screen.getByText(manual.message).parentElement!
  await user.hover(first)
  await user.click(within(first).getByRole("button", { name: t("stash.pop") }))
  expect(onPop).toHaveBeenCalledWith("stash@{0}")
  expect(onDrop).not.toHaveBeenCalled()
  const second = screen.getByText("feature/topic").parentElement!
  await user.hover(second)
  await user.click(within(second).getByRole("button", { name: t("stash.drop") }))
  expect(onDrop).toHaveBeenCalledWith("stash@{1}")
  expect(onPop).toHaveBeenCalledTimes(1)
  rerender(<Stashes stashes={[]} onPop={onPop} onDrop={onDrop} />)
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
})

// ---- Changes/Unknown co-authors ----
const unknown = (username: string) => ({ kind: "unknown" as const, username, state: "error" as const })
test("unknown co-authors: only Commit anyway commits, exactly once (CommitAnyway, CancelDoesNotCommit)", async () => {
  const user = userEvent.setup()
  for (const [button, commits] of [
    [t("unknownAuthors.commitAnyway"), 1],
    [t("common.cancel"), 0]
  ] as const) {
    const onCommit = mock()
    const onDismissed = mock()
    render(
      <UnknownAuthors
        authors={[unknown("ghost-author"), unknown("someone-else")]}
        onCommit={onCommit}
        onDismissed={onDismissed}
      />
    )
    expect(await screen.findByText("ghost-author")).toBeVisible()
    await user.click(screen.getByRole("button", { name: button }))
    expect(onCommit).toHaveBeenCalledTimes(commits)
    await waitFor(() => expect(onDismissed).toHaveBeenCalled())
    cleanup()
  }
})
test("unknown co-authors: more than ten collapse to a count (ManyAuthors)", async () => {
  render(
    <UnknownAuthors
      authors={Array.from({ length: 11 }, (_, i) => unknown(`user-${i}`))}
      onCommit={() => {}}
      onDismissed={() => {}}
    />
  )
  expect(await screen.findByText(t("unknownAuthors.countUsersWerentFound", { count: 11 }))).toBeVisible()
  expect(screen.queryByText("user-0")).not.toBeInTheDocument()
})

// ---- Onboarding/DesktopImport ----
const importedState = {
  repositories: ["/Projects/example"],
  selectedRepository: "/Projects/example",
  desktopImportHandled: true,
  sidebarWidth: 250,
  selectedTab: "changes",
  theme: "dark",
  language: "",
  repoOwnership: {},
  accountHosts: [],
  oauthClients: {}
}
const detected = { installed: true, hasData: true, handled: false }
function desktopImport(overrides: Parameters<typeof installNativeFixtures>[0] = {}) {
  fixtures({ detect_desktop_import: () => detected, finish_desktop_import: () => importedState, ...overrides })
  const onImported = mock()
  render(
    <DesktopImportWelcome onImported={onImported}>
      <h1>Continue setup</h1>
    </DesktopImportWelcome>
  )
  return onImported
}
test("Desktop import: Import finishes with import:true and hands the merged state on (Import)", async () => {
  const user = userEvent.setup()
  const onImported = desktopImport()
  await user.click(await screen.findByRole("button", { name: t("prefs.desktopImportAction") }))
  expect(await screen.findByRole("heading", { name: "Continue setup" })).toBeVisible()
  expect(callsOf("finish_desktop_import")).toEqual([{ import: true }])
  expect(onImported).toHaveBeenCalledWith(importedState)
})
test("Desktop import: not installed or already handled skips straight on with one native call (NotInstalled, AlreadyHandled)", async () => {
  for (const state of [
    { installed: false, hasData: false, handled: false },
    { ...detected, handled: true }
  ]) {
    desktopImport({ detect_desktop_import: () => state })
    expect(await screen.findByRole("heading", { name: "Continue setup" })).toBeVisible()
    expect(nativeCall).toHaveBeenCalledTimes(1)
    cleanup()
    uninstall()
  }
})
test("Desktop import: a failure stays on the step with an alert and can be retried (FailureAndRetry)", async () => {
  const user = userEvent.setup()
  const onImported = desktopImport({
    finish_desktop_import: () => {
      throw new Error("Unable to save imported settings")
    }
  })
  const button = await screen.findByRole("button", { name: t("prefs.desktopImportAction") })
  await user.click(button)
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to save")
  expect(onImported).not.toHaveBeenCalled()
  expect(screen.queryByRole("heading", { name: "Continue setup" })).toBeNull()
  await user.click(button)
  await waitFor(() => expect(callsOf("finish_desktop_import")).toHaveLength(2))
})
test("Desktop import: while importing both buttons are disabled (Busy)", async () => {
  const user = userEvent.setup()
  desktopImport({ finish_desktop_import: () => new Promise<never>(() => {}) })
  await user.click(await screen.findByRole("button", { name: t("prefs.desktopImportAction") }))
  expect(await screen.findByRole("button", { name: t("prefs.desktopImporting") })).toBeDisabled()
  expect(screen.getByRole("button", { name: t("welcome.desktopSkip") })).toBeDisabled()
})

// ---- History/Tags ----
const tagFixtures = {
  tags: () => ["v1.0", "v2.0-beta"],
  remotes: () => [["origin", "https://github.com/gitcub/gitcub.git"]],
  push: () => undefined
}
async function openTags(overrides: Parameters<typeof installNativeFixtures>[0] = {}) {
  fixtures({ ...tagFixtures, ...overrides })
  const user = userEvent.setup()
  render(<Tags repo={repo} />)
  await user.click(screen.getByRole("button", { name: t("tags.title") }))
  const dialog = within(await screen.findByRole("dialog"))
  await dialog.findAllByText(/v1\.0|v2\.0-beta/)
  return { user, dialog }
}
const deleteTag = () => callsOf("delete_tag")
test("tags: search filters, and push sends the tag refspec (SearchAndPush)", async () => {
  const { user, dialog } = await openTags()
  await user.type(dialog.getByRole("textbox", { name: t("tags.search") }), "v2")
  expect(dialog.queryByText("v1.0")).not.toBeInTheDocument()
  await user.click(dialog.getByRole("button", { name: t("tags.push") }))
  await waitFor(() =>
    expect(callsOf("push")).toContainEqual(
      expect.objectContaining({
        repo,
        remote: "origin",
        refspec: "refs/tags/v2.0-beta:refs/tags/v2.0-beta",
        setUpstream: false,
        forceWithLease: false
      })
    )
  )
})
test("tags: local deletion happens only after confirmation, refreshes the list and never pushes (DeleteLocal, CancelDeletion)", async () => {
  const cancelled = await openTags({ "plugin:dialog|message": () => "Cancel" })
  await cancelled.user.click(cancelled.dialog.getAllByRole("button", { name: t("tags.deleteLocal") })[0])
  await waitFor(() => expect(callsOf("plugin:dialog|message")).toHaveLength(1))
  expect(deleteTag()).toEqual([])
  cleanup()
  uninstall()
  let removed = false
  const { user, dialog } = await openTags({
    tags: () => (removed ? ["v2.0-beta"] : tagFixtures.tags()),
    "plugin:dialog|message": () => "Ok",
    delete_tag: () => {
      removed = true
    }
  })
  await user.click(dialog.getAllByRole("button", { name: t("tags.deleteLocal") })[0])
  await waitFor(() => expect(deleteTag()).toEqual([{ repo, name: "v1.0" }]))
  await waitFor(() => expect(dialog.queryByText("v1.0")).not.toBeInTheDocument())
  expect(dialog.getByText("v2.0-beta")).toBeVisible()
  expect(callsOf("push")).toEqual([])
})
test("tags: remote deletion pushes an empty source refspec and keeps the local tag (DeleteRemote)", async () => {
  const { user, dialog } = await openTags({ "plugin:dialog|message": () => "Ok" })
  await user.click(dialog.getAllByRole("button", { name: t("tags.deleteRemote") })[0])
  await waitFor(() =>
    expect(callsOf("push")).toContainEqual(
      expect.objectContaining({ repo, remote: "origin", refspec: ":refs/tags/v1.0", setUpstream: false })
    )
  )
  expect(deleteTag()).toEqual([])
})
test("tags: a failed confirmation shows the error and deletes nothing (FailedConfirmation)", async () => {
  const { user, dialog } = await openTags({ "plugin:dialog|message": unavailable })
  const remove = dialog.getAllByRole("button", { name: t("tags.deleteLocal") })[0]
  await user.click(remove)
  expect(await dialog.findByRole("alert")).toHaveTextContent("Preview service unavailable")
  expect(remove).toBeEnabled()
  expect(deleteTag()).toEqual([])
})
test("tags: a pending confirmation opens once and locks the list until answered (PendingConfirmation)", async () => {
  let answer!: (value: string) => void
  const { user, dialog } = await openTags({
    "plugin:dialog|message": () => new Promise<string>(resolve => (answer = resolve))
  })
  const remove = dialog.getAllByRole("button", { name: t("tags.deleteLocal") })[0]
  await user.dblClick(remove)
  await waitFor(() => expect(callsOf("plugin:dialog|message")).toHaveLength(1))
  expect(remove).toBeDisabled()
  answer("Cancel")
  await waitFor(() => expect(remove).toBeEnabled())
  expect(deleteTag()).toEqual([])
})
test("tags: a failed load shows an alert and Refresh recovers (RetryLoad)", async () => {
  let attempts = 0
  fixtures({ ...tagFixtures, tags: () => (++attempts === 1 ? unavailable() : tagFixtures.tags()) })
  const user = userEvent.setup()
  render(<Tags repo={repo} />)
  await user.click(screen.getByRole("button", { name: t("tags.title") }))
  const dialog = within(await screen.findByRole("dialog"))
  expect(await dialog.findByRole("alert")).toHaveTextContent("Preview service unavailable")
  const retry = dialog.getByRole("button", { name: t("inbox.refresh") })
  await waitFor(() => expect(retry).toBeEnabled())
  await user.click(retry)
  expect(await dialog.findByText("v1.0")).toBeVisible()
  expect(dialog.queryByRole("alert")).not.toBeInTheDocument()
})

// ---- Collaboration/Create PR or MR ----
const prTarget: PullRequestTargets = {
  kind: "github",
  sourceId: 12,
  remote: { host: "github.example:8443", owner: "contributor", name: "fork" },
  targets: [{ fullName: "upstream/project", id: 32, defaultBranch: "main", branches: ["main", "release"] }]
}
const createFixtures = {
  remotes: () => [["origin", "https://github.example:8443/contributor/fork.git"]],
  branch_details: () => [],
  pull_request_targets: () => prTarget,
  push: () => undefined
}
function createRequest(
  overrides: Parameters<typeof installNativeFixtures>[0] = {},
  props: Partial<ComponentProps<typeof CreatePullRequest>> = {}
) {
  fixtures({ ...createFixtures, ...overrides })
  openedUrls.length = 0
  const args = {
    open: true,
    repo,
    branch: "feature/中文" as string | null,
    remote: prTarget.remote,
    onOpenChange: mock(),
    onPushed: mock(),
    ...props
  }
  const view = render(<CreatePullRequest {...args} />)
  // 推送中按钮里多一个 Spinner，可访问名称前面会带上它的标签
  const submit = () => screen.getByRole("button", { name: new RegExp(`${t("pr.createAndOpen")}$`) })
  return { args, view, submit }
}
test("create PR: pushes the branch with upstream, then opens the compare page on the chosen base and closes (GitHubFork)", async () => {
  const user = userEvent.setup()
  const { args, submit } = createRequest()
  await waitFor(() => expect(submit()).toBeEnabled())
  await user.selectOptions(screen.getByLabelText(t("pr.basePlaceholder")), "release")
  await user.click(submit())
  await waitFor(() => expect(args.onPushed).toHaveBeenCalledTimes(1))
  expect(callsOf("push")).toEqual([
    expect.objectContaining({
      repo,
      remote: "origin",
      refspec: "HEAD:refs/heads/feature/中文",
      setUpstream: true,
      forceWithLease: false
    })
  ])
  await waitFor(() =>
    expect(openedUrls).toEqual([
      "https://github.example:8443/upstream/project/compare/release...contributor%3Afeature%2F%E4%B8%AD%E6%96%87?expand=1"
    ])
  )
  expect(args.onOpenChange).toHaveBeenCalledWith(false)
})
test("create MR: GitLab subgroups open merge_requests/new with both project IDs (GitLabSubgroup)", async () => {
  const user = userEvent.setup()
  const { args, submit } = createRequest({
    pull_request_targets: () => ({
      ...prTarget,
      kind: "gitlab",
      remote: { host: "gitlab.example", owner: "group/sub", name: "fork" },
      targets: [{ ...prTarget.targets[0], fullName: "group/upstream/project" }]
    })
  })
  await waitFor(() => expect(submit()).toBeEnabled())
  await user.click(submit())
  await waitFor(() => expect(args.onOpenChange).toHaveBeenCalledWith(false))
  const url = new URL(openedUrls[0])
  expect(url.pathname).toBe("/group/upstream/project/-/merge_requests/new")
  expect(url.searchParams.get("merge_request[source_project_id]")).toBe("12")
  expect(url.searchParams.get("merge_request[target_project_id]")).toBe("32")
  expect(url.searchParams.get("merge_request[source_branch]")).toBe("feature/中文")
})
test("create PR: detached HEAD and pending remote discovery cannot submit (DetachedHead, LoadingRemoteDiscovery)", () => {
  createRequest({}, { branch: null })
  expect(screen.getByRole("button", { name: t("pr.createAndOpen") })).toBeDisabled()
  cleanup()
  uninstall()
  createRequest({ remotes: pending })
  expect(screen.getByRole("button", { name: t("pr.createAndOpen") })).toBeDisabled()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})
test("create PR: a failed push shows the error and neither opens a page nor closes (FailedPush)", async () => {
  const user = userEvent.setup()
  const { args, submit } = createRequest({ push: unavailable })
  await waitFor(() => expect(submit()).toBeEnabled())
  await user.click(submit())
  expect(await screen.findByRole("alert")).toHaveTextContent("Preview service unavailable")
  expect(args.onPushed).not.toHaveBeenCalled()
  expect(args.onOpenChange).not.toHaveBeenCalled()
  expect(openedUrls).toEqual([])
})
test("create PR: failed target or remote discovery can be retried (RetryTargets, RetryRemoteDiscovery)", async () => {
  const user = userEvent.setup()
  for (const command of ["pull_request_targets", "remotes"] as const) {
    let attempts = 0
    const { submit } = createRequest({
      [command]: () => (++attempts === 1 ? unavailable() : createFixtures[command]())
    })
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview service unavailable")
    const retry = screen.getByRole("button", { name: t("inbox.refresh") })
    await waitFor(() => expect(retry).toBeEnabled())
    await user.click(retry)
    await waitFor(() => expect(submit()).toBeEnabled())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(attempts).toBe(2)
    cleanup()
    uninstall()
  }
})
test("create PR: a pending push runs once and Escape does not close the dialog (PendingPushCannotRepeat)", async () => {
  const user = userEvent.setup()
  const { args, submit } = createRequest({ push: pending })
  await waitFor(() => expect(submit()).toBeEnabled())
  await user.dblClick(submit())
  await waitFor(() => expect(callsOf("push")).toHaveLength(1))
  expect(submit()).toBeDisabled()
  await user.keyboard("{Escape}")
  expect(screen.getByRole("dialog")).toBeVisible()
  expect(args.onOpenChange).not.toHaveBeenCalled()
  expect(args.onPushed).not.toHaveBeenCalled()
  expect(openedUrls).toEqual([])
})
test("create PR: a push that finishes after the branch changed is ignored (IgnorePushCompletionAfterBranchSwitch)", async () => {
  const user = userEvent.setup()
  const push = Promise.withResolvers<void>()
  const { args, view, submit } = createRequest({ push: () => push.promise })
  await waitFor(() => expect(submit()).toBeEnabled())
  await user.click(submit())
  await waitFor(() => expect(callsOf("push")).toHaveLength(1))
  view.rerender(<CreatePullRequest {...args} branch="next" />)
  await waitFor(() => expect(callsOf("branch_details")).toHaveLength(2))
  await waitFor(() => expect(submit()).toBeEnabled())
  push.resolve()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(args.onPushed).not.toHaveBeenCalled()
  expect(args.onOpenChange).not.toHaveBeenCalled()
  expect(openedUrls).toEqual([])
  expect(screen.getByRole("dialog")).toBeVisible()
})

// Desktop app/test/unit/ui/add-worktree-dialog-test.tsx（9822d840e）'keeps failures open, reports the error and re-enables creation'，
// 按 GitCub 的工作树对话框改写：它创建成功后也不关闭，所以原版的「关闭前先清 creating」不适用。
test("worktrees: a failed creation stays open, reports the error and can be retried (FailedCreationCanRetry)", async () => {
  const user = userEvent.setup()
  let attempts = 0
  fixtures({
    worktrees: () => [{ path: "/preview/repository", branch: "main", main: true }],
    branches: () => [{ name: "main" }],
    add_worktree_at: () => {
      if (attempts++ === 0) throw new Error("fatal: '/preview/feature' already exists")
    }
  })
  const onClose = mock()
  render(<Worktrees repo="/preview/repository" onClose={onClose} onOpen={mock()} onMove={mock()} />)
  const create = await screen.findByRole("button", { name: t("worktree.create") })
  await waitFor(() => expect(callsOf("branches")).toHaveLength(1))
  const pathInput = screen.getByLabelText(t("worktree.path"))
  await user.type(screen.getByLabelText(t("worktree.branch")), "feature")
  await user.type(pathInput, "/preview/feature")
  await user.click(create)
  expect(await screen.findByRole("alert")).toHaveTextContent("already exists")
  await waitFor(() => expect(create).toBeEnabled())
  expect(pathInput).toHaveValue("/preview/feature")
  expect(onClose).not.toHaveBeenCalled()
  await user.click(create)
  await waitFor(() => expect(pathInput).toHaveValue(""))
  expect(screen.queryByRole("alert")).toBeNull()
  expect(callsOf("add_worktree_at")).toEqual(
    Array.from({ length: 2 }, () => ({
      repo: "/preview/repository",
      path: "/preview/feature",
      createBranch: "feature",
      commitish: "HEAD"
    }))
  )
  expect(callsOf("worktrees")).toHaveLength(2)
})

// ---- Settings/Repository settings ----
const ok = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  path: "/preview/repository",
  gitError: null,
  gitErrorDescription: null
}
const settingsFixtures = {
  remotes: () => [
    ["origin", "https://github.com/gitcub/gitcub.git"],
    ["upstream", "https://github.com/desktop/desktop.git"]
  ],
  read_gitignore: () => "node_modules\n",
  get_config_value: () => null,
  global_config_value: (args: Record<string, unknown>) =>
    args.key === "user.name" ? "Global Name" : "global@example.test",
  git_execute: () => ok,
  set_remote_url: () => undefined,
  write_gitignore: () => undefined,
  pull_request_repository: (args: Record<string, unknown>) => args
}
const hosted = { host: "github.com", owner: "gitcub", name: "gitcub" }
function repositorySettings(overrides: Parameters<typeof installNativeFixtures>[0] = {}) {
  fixtures({ ...settingsFixtures, ...overrides })
  const args = { onDismissed: mock(), onPublish: mock() }
  render(<RepositorySettings repo="/preview/repository" primaryRemote="origin" hosted={hosted} {...args} />)
  return args
}
const settingsWrites = () =>
  nativeCall.mock.calls.filter(
    ([command, args]) =>
      ["set_remote_url", "write_gitignore"].includes(command) ||
      (command === "git_execute" && (args as { args: string[] }).args[0] === "config")
  )
const ignoredFiles = () => screen.getByRole("textbox", { name: t("repositorySettings.ignoredFiles") })
test("repository settings: drafts are written only on Save, remote trimmed, local identity only when chosen (SaveWritesDrafts)", async () => {
  const user = userEvent.setup()
  const args = repositorySettings()
  const url = await screen.findByLabelText(t("repositorySettings.primaryRemoteRepositoryUrl", { name: "origin" }))
  await waitFor(() => expect(url).toHaveValue("https://github.com/gitcub/gitcub.git"))
  await user.clear(url)
  await user.type(url, "https://github.com/gitcub/renamed.git ")
  await user.click(screen.getByRole("tab", { name: t("repositorySettings.ignoredFiles") }))
  await waitFor(() => expect(ignoredFiles()).toBeEnabled())
  await user.type(ignoredFiles(), "target\n")
  await user.click(screen.getByRole("tab", { name: t("repositorySettings.gitConfig") }))
  const name = screen.getByLabelText(t("prefs.name"))
  expect(name).toBeDisabled()
  expect(name).toHaveValue("Global Name")
  await user.click(screen.getByRole("radio", { name: t("repositorySettings.useALocalGitConfig") }))
  await user.clear(name)
  await user.type(name, "Local Name")
  expect(settingsWrites()).toEqual([])
  await user.click(screen.getByRole("button", { name: t("common.save") }))
  await waitFor(() => expect(args.onDismissed).toHaveBeenCalled())
  expect(callsOf("set_remote_url")).toEqual([
    { repo: "/preview/repository", name: "origin", url: "https://github.com/gitcub/renamed.git" }
  ])
  expect(callsOf("write_gitignore")).toEqual([{ repo: "/preview/repository", content: "node_modules\ntarget\n" }])
  expect(
    settingsWrites()
      .filter(([command]) => command === "git_execute")
      .map(([, args]) => (args as { args: string[] }).args)
  ).toEqual([
    ["config", "--replace-all", "user.name", "Local Name"],
    ["config", "--replace-all", "user.email", "global@example.test"]
  ])
})
// Desktop app/test/unit/ui/repository-settings-test.tsx（a6ff9b27d）'repository settings Git identity refresh' 的两个场景，
// 按 GitCub 的实现改写：作者信息在对话框关闭时由 app 整体刷新，所以断言落在「写了什么、对话框是否还开着」上。
test("repository settings: a failed email write after the name was written keeps the dialog open with the error (PartialIdentityWriteStaysOpen)", async () => {
  const user = userEvent.setup()
  const args = repositorySettings({
    git_execute: (call: Record<string, unknown>) => {
      const argv = (call as { args: string[] }).args
      if (argv[0] === "config" && argv[2] === "user.email") throw new Error("could not lock config file .git/config")
      return ok
    }
  })
  await user.click(await screen.findByRole("tab", { name: t("repositorySettings.gitConfig") }))
  await user.click(screen.getByRole("radio", { name: t("repositorySettings.useALocalGitConfig") }))
  const name = screen.getByLabelText(t("prefs.name"))
  await user.clear(name)
  await user.type(name, "Local Name")
  await user.click(screen.getByRole("button", { name: t("common.save") }))
  expect(await screen.findByText(/could not lock config file/)).toBeVisible()
  expect(args.onDismissed).not.toHaveBeenCalled()
  expect(settingsWrites().map(([, call]) => (call as { args: string[] }).args)).toEqual([
    ["config", "--replace-all", "user.name", "Local Name"],
    ["config", "--replace-all", "user.email", "global@example.test"]
  ])
  await waitFor(() => expect(screen.getByRole("button", { name: t("common.save") })).toBeEnabled())
  // 关闭对话框是 app 刷新作者信息的时机：名字已经写进去了，这一步不能被失败挡住
  await user.click(screen.getByRole("button", { name: t("common.cancel") }))
  expect(args.onDismissed).toHaveBeenCalledTimes(1)
})
test("repository settings: an unchanged local identity is not written again (UnchangedLocalIdentityNotWritten)", async () => {
  const user = userEvent.setup()
  const args = repositorySettings({
    get_config_value: (call: Record<string, unknown>) =>
      call.key === "user.name" ? "Local Name" : call.key === "user.email" ? "local@example.test" : null
  })
  await user.click(await screen.findByRole("tab", { name: t("repositorySettings.gitConfig") }))
  await waitFor(() => expect(screen.getByLabelText(t("prefs.name"))).toHaveValue("Local Name"))
  await user.click(screen.getByRole("button", { name: t("common.save") }))
  await waitFor(() => expect(args.onDismissed).toHaveBeenCalled())
  expect(settingsWrites()).toEqual([])
})
test("repository settings: Cancel writes nothing (CancelWritesNothing)", async () => {
  const user = userEvent.setup()
  const args = repositorySettings()
  await user.click(await screen.findByRole("tab", { name: t("repositorySettings.ignoredFiles") }))
  await waitFor(() => expect(ignoredFiles()).toBeEnabled())
  await user.type(ignoredFiles(), "dist\n")
  await user.click(screen.getByRole("button", { name: t("common.cancel") }))
  expect(args.onDismissed).toHaveBeenCalled()
  expect(settingsWrites()).toEqual([])
})
test("repository settings: an unreadable .gitignore is locked and never overwritten (FailedIgnoreReadCannotWrite)", async () => {
  const user = userEvent.setup()
  repositorySettings({
    read_gitignore: () => {
      throw new Error("Cannot read ignore file")
    }
  })
  expect(await screen.findByText(/Cannot read ignore file/)).toBeVisible()
  await user.click(screen.getByRole("tab", { name: t("repositorySettings.ignoredFiles") }))
  expect(ignoredFiles()).toBeDisabled()
  await user.click(screen.getByRole("button", { name: t("common.save") }))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(callsOf("write_gitignore")).toEqual([])
})
test("repository settings: removing another remote applies at once and keeps unsaved drafts (RemoveOtherRemoteKeepsDrafts)", async () => {
  const user = userEvent.setup()
  let removed = false
  repositorySettings({
    remotes: () => (removed ? [settingsFixtures.remotes()[0]] : settingsFixtures.remotes()),
    remove_remote: () => {
      removed = true
    }
  })
  await user.click(await screen.findByRole("tab", { name: t("repositorySettings.ignoredFiles") }))
  await waitFor(() => expect(ignoredFiles()).toBeEnabled())
  await user.type(ignoredFiles(), "custom-output\n")
  await user.click(screen.getByRole("tab", { name: t("repositorySettings.remote") }))
  await user.click(screen.getByRole("button", { name: t("prefs.removeRemote") }))
  await waitFor(() => expect(screen.queryByText("upstream")).not.toBeInTheDocument())
  await user.click(screen.getByRole("tab", { name: t("repositorySettings.ignoredFiles") }))
  expect(ignoredFiles()).toHaveValue("node_modules\ncustom-output\n")
})
test("repository settings: no remote offers Publish; a non-fork has no Fork Behavior tab (NoRemote, NotAForkHasNoForkBehavior)", async () => {
  const user = userEvent.setup()
  const args = repositorySettings({ remotes: () => [] })
  await user.click(await screen.findByRole("button", { name: "Publish" }))
  expect(args.onPublish).toHaveBeenCalled()
  cleanup()
  uninstall()
  repositorySettings()
  await screen.findByRole("tab", { name: t("repositorySettings.gitConfig") })
  await waitFor(() => expect(callsOf("pull_request_repository")).toContainEqual(hosted))
  expect(screen.queryByRole("tab", { name: t("repositorySettings.forkBehavior") })).not.toBeInTheDocument()
})

// ---- Collaboration/PR and MR list ----
const prRemote = { host: "gitlab.example", owner: "group/sub", name: "project" }
const request: PullRequest = {
  number: 42,
  createdAt: "2026-01-01T12:00:00Z",
  title: "Fix nested groups",
  author: "bear",
  head: "feature",
  base: "main",
  headSha: "a".repeat(40),
  draft: false,
  url: "https://gitlab.example/group/sub/project/-/merge_requests/42",
  checks: "failure"
}
const checkRun: CheckRun = {
  name: "Typecheck",
  status: "completed",
  conclusion: "failure",
  url: "https://gitlab.example/group/sub/project/-/jobs/12",
  retry: { kind: "gitlabJob", id: 12 },
  id: 12,
  rerunnable: true,
  jobId: 12
}
const listFixtures = {
  pull_request_repository: () => prRemote,
  pull_requests: () => [
    request,
    { ...request, number: 43, title: "Documentation", url: `${request.url}3`, draft: true }
  ],
  desktop_dialog_did_open: () => undefined,
  check_runs: () => [checkRun],
  check_rerun_eligibility: () => [12],
  rerun_check: () => undefined
}
function pullRequests(
  overrides: Parameters<typeof installNativeFixtures>[0] = {},
  props: Partial<ComponentProps<typeof PullRequests>> = {}
) {
  // 列表数据在 store 里，跨用例会留着；每个用例从未加载开始
  usePullRequestsStore.setState({ repo: null, remote: null, target: null, list: [], loading: false, error: null })
  fixtures({ ...listFixtures, ...overrides })
  layout()
  openedUrls.length = 0
  const args = {
    repo: "/fixture",
    remote: prRemote as typeof prRemote | null,
    isOnDefaultBranch: false,
    onCheckout: mock(),
    onCreate: mock(),
    onCreateBranch: mock(),
    ...props
  }
  const view = render(
    <div className="branches-container h-96" style={{ width: 365 }}>
      <div className="branches-container-panel">
        <PullRequests {...(args as ComponentProps<typeof PullRequests>)} />
      </div>
    </div>
  )
  return { args, view }
}
test("PR list: filtering narrows the list and clicking a row checks it out from the right remote (FilterAndCheckout)", async () => {
  const user = userEvent.setup()
  const { args } = pullRequests()
  await screen.findByText(request.title)
  expect(screen.getByText(t("pr.pullRequestsIn", { repository: "group/sub/project" }))).toBeVisible()
  await user.type(screen.getByPlaceholderText(t("desktopUI.filter")), "nested")
  expect(screen.queryByText("Documentation")).not.toBeInTheDocument()
  // 过滤会把匹配部分高亮拆成几段文字，按行的可访问名称找
  await user.click(screen.getByRole("listitem", { name: new RegExp(request.title) }))
  expect(args.onCheckout).toHaveBeenCalledWith(request, prRemote)
})
const group = () => t("pr.pullRequestsIn", { repository: "group/sub/project" })
test("PR list: View online opens the request page and does not check out (ReviewOnPlatform)", async () => {
  const user = userEvent.setup()
  const { args } = pullRequests()
  const row = (await screen.findByText(request.title)).closest('[data-slot="context-menu-trigger"]')!
  fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
  await user.click(await screen.findByRole("menuitem", { name: t("pr.viewOnline") }))
  await waitFor(() => expect(openedUrls).toEqual([request.url]))
  expect(args.onCheckout).not.toHaveBeenCalled()
})
test("PR list: Enter on a focused row checks it out (KeyboardCheckout)", async () => {
  const user = userEvent.setup()
  const { args } = pullRequests()
  const row = await screen.findByRole("listitem", { name: `#42 ${request.title}, ${group()}` })
  row.focus()
  await user.keyboard("{Enter}")
  expect(args.onCheckout).toHaveBeenCalledWith(request, prRemote)
})
test("PR list: an empty list offers to create one; a failed load can be refreshed (Empty, RetryLoadingFailure)", async () => {
  const user = userEvent.setup()
  const empty = pullRequests({ pull_requests: () => [] })
  await user.click(await screen.findByRole("button", { name: "create a pull request" }))
  expect(empty.args.onCreate).toHaveBeenCalledTimes(1)
  cleanup()
  unlayout()
  uninstall()
  let attempt = 0
  pullRequests({ pull_requests: () => (++attempt === 1 ? unavailable() : [request]) })
  expect(await screen.findByText(/Preview service unavailable/)).toBeVisible()
  await user.click(screen.getByRole("button", { name: t("pr.refreshPullRequests") }))
  expect(await screen.findByText(request.title)).toBeVisible()
})
test("PR list: a repository lookup that finishes after switching is ignored (IgnoreOldRepositoryLookup)", async () => {
  const user = userEvent.setup()
  const old = Promise.withResolvers<typeof prRemote>()
  const nextRemote = { ...prRemote, name: "next-project" }
  const { args, view } = pullRequests({
    pull_request_repository: remote => (remote.name === prRemote.name ? old.promise : nextRemote)
  })
  await waitFor(() => expect(callsOf("pull_request_repository")).toContainEqual(prRemote))
  view.rerender(
    <div className="branches-container h-96" style={{ width: 365 }}>
      <div className="branches-container-panel">
        <PullRequests {...(args as ComponentProps<typeof PullRequests>)} remote={nextRemote} />
      </div>
    </div>
  )
  await screen.findByText(request.title)
  old.resolve(prRemote)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(callsOf("pull_requests")).not.toContainEqual(expect.objectContaining({ name: prRemote.name }))
  await user.click(screen.getAllByText(request.title)[0])
  expect(args.onCheckout).toHaveBeenCalledWith(request, nextRemote)
})
async function openChecks(user: ReturnType<typeof userEvent.setup>) {
  await user.click((await screen.findAllByRole("button", { name: t("pr.checksDetail") }))[0])
}
test("CI rerun: nothing is rerun until confirmed, then failed checks rerun on the request's repository (ConfirmRetryFailedCI)", async () => {
  const user = userEvent.setup()
  pullRequests()
  await openChecks(user)
  await user.click(await screen.findByRole("button", { name: t("ci.rerun") }))
  await user.click(await screen.findByRole("menuitem", { name: t("ci.rerunFailed") }))
  const dialog = within(await screen.findByRole("dialog", { name: t("ci.rerunFailed") }))
  expect(callsOf("rerun_check")).toEqual([])
  await user.click(dialog.getByRole("button", { name: t("ci.rerunChecks") }))
  await waitFor(() =>
    expect(callsOf("rerun_check")).toEqual([
      expect.objectContaining({
        host: prRemote.host,
        owner: prRemote.owner,
        name: prRemote.name,
        target: checkRun.retry,
        mode: "failed",
        jobId: undefined
      })
    ])
  )
})
test("CI rerun: with nothing rerunnable the confirm button is disabled and sends nothing (UnavailableChecksCannotRerun)", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  pullRequests({ check_rerun_eligibility: () => [] })
  await openChecks(user)
  await user.click(await screen.findByRole("button", { name: t("ci.rerun") }))
  await user.click(await screen.findByRole("menuitem", { name: t("ci.rerunFailed") }))
  const dialog = within(await screen.findByRole("dialog", { name: t("ci.rerunFailed") }))
  expect(await dialog.findByText(t("ci.noneRerunnable"))).toBeVisible()
  const confirm = dialog.getByRole("button", { name: t("ci.rerunChecks") })
  expect(confirm).toHaveAttribute("aria-disabled", "true")
  await user.click(confirm)
  expect(callsOf("rerun_check")).toEqual([])
})
const githubRemote = { host: "github.com", owner: "bear", name: "project" }
const githubRun: CheckRun = {
  ...checkRun,
  checkSuiteId: 100,
  retry: { kind: "githubWorkflow", id: 200 },
  url: "https://github.com/bear/project/actions/runs/200/job/12",
  workflow: {
    id: 200,
    workflow_id: 1,
    check_suite_id: 100,
    name: "Build workflow",
    event: "pull_request",
    created_at: "2026-10-21T00:00:00Z",
    cancel_url: "",
    rerun_url: "",
    logs_url: ""
  },
  steps: [
    {
      name: "Compile",
      number: 1,
      status: APICheckStatus.Completed,
      conclusion: APICheckConclusion.Failure,
      started_at: "2026-10-21T00:00:00Z",
      completed_at: "2026-10-21T00:00:10Z",
      log: ""
    }
  ]
}
const githubList = {
  pull_request_repository: () => githubRemote,
  pull_requests: () => [{ ...request, url: "https://github.com/bear/project/pull/42" }],
  check_runs: () => [githubRun]
}
test("CI: a failed GitHub job expands to its steps, a step opens its log anchor, and a job reruns alone (GitHubFailureAutomaticallyExpands)", async () => {
  const user = userEvent.setup()
  pullRequests(githubList, { remote: githubRemote })
  await openChecks(user)
  expect(await screen.findByText("Build workflow")).toBeVisible()
  expect(await screen.findByText("Compile")).toBeVisible()
  await user.click(screen.getByRole("link", { name: t("desktopUI.viewStep", { name: "Compile" }) }))
  await waitFor(() => expect(openedUrls).toContain(`${githubRun.url}/#step:1:1`))
  await user.click(screen.getByRole("button", { name: t("ci.rerunJob", { name: githubRun.name }) }))
  const dialog = within(await screen.findByRole("dialog", { name: t("ci.rerunSingle") }))
  await user.click(await dialog.findByRole("button", { name: t("ci.rerunChecks") }))
  await waitFor(() =>
    expect(callsOf("rerun_check")).toEqual([
      expect.objectContaining({ target: githubRun.retry, mode: "job", jobId: 12 })
    ])
  )
})
test("CI rerun: a failed rerun shows the error and can be confirmed again (RerunFailureIsRetryable)", async () => {
  const user = userEvent.setup()
  let attempts = 0
  pullRequests(
    {
      ...githubList,
      rerun_check: () => {
        if (++attempts === 1) throw new Error("HTTP 503 temporary failure")
      }
    },
    { remote: githubRemote }
  )
  await openChecks(user)
  await user.click(await screen.findByRole("button", { name: t("ci.rerunJob", { name: githubRun.name }) }))
  const dialog = within(await screen.findByRole("dialog", { name: t("ci.rerunSingle") }))
  const confirm = await dialog.findByRole("button", { name: t("ci.rerunChecks") })
  await user.click(confirm)
  expect(await dialog.findByRole("alert")).toHaveTextContent("HTTP 503")
  await user.click(confirm)
  await waitFor(() => expect(callsOf("rerun_check")).toHaveLength(2))
})

// ---- 过期结果丢弃：History/Blame、Diff/Image loading、Diff/Submodule ----
const blameLines = ["const greeting = 'hello'", "console.log(greeting)"].map((content, index) => ({
  line: index + 1,
  sha: commit.sha,
  shortSha: commit.shortSha,
  author: commit.authorName,
  time: commit.time,
  summary: commit.summary,
  content
}))
test("blame: a commit button selects that commit and Close closes; failures are shown (LinesAndNavigation, Failure)", async () => {
  const user = userEvent.setup()
  fixtures({ blame: () => blameLines })
  layout(800, 384)
  const onClose = mock()
  const onSelectCommit = mock()
  render(<Blame repo={repo} file="src/main.tsx" onClose={onClose} onSelectCommit={onSelectCommit} />)
  expect(await screen.findByText(blameLines[1].content)).toBeVisible()
  await user.click(screen.getAllByRole("button", { name: `${commit.shortSha} ${commit.authorName}` })[0])
  expect(onSelectCommit).toHaveBeenCalledWith(commit.sha)
  await user.click(screen.getByRole("button", { name: t("common.close") }))
  expect(onClose).toHaveBeenCalledTimes(1)
  cleanup()
  uninstall()
  fixtures({ blame: unavailable })
  render(<Blame repo={repo} file="src/main.tsx" onClose={onClose} onSelectCommit={onSelectCommit} />)
  expect(await screen.findByText(/Preview service unavailable/)).toBeVisible()
})
test("blame: a late result or error for the previous file is ignored (IgnoreLateFileResult, IgnoreLateFileError)", async () => {
  for (const fail of [false, true]) {
    const old = Promise.withResolvers<typeof blameLines>()
    const nextLines = [{ ...blameLines[0], content: "new file content", sha: "c".repeat(40), shortSha: "ccccccc" }]
    fixtures({ blame: args => (args.file === "src/main.tsx" ? old.promise : nextLines) })
    layout(800, 384)
    const props = { repo, onClose: () => {}, onSelectCommit: () => {} }
    const view = render(<Blame {...props} file="src/main.tsx" />)
    await waitFor(() => expect(callsOf("blame")).toEqual([{ repo, file: "src/main.tsx" }]))
    view.rerender(<Blame {...props} file="src/next.tsx" />)
    expect(await screen.findByText("new file content")).toBeVisible()
    if (fail) old.reject(new Error("Old file failed"))
    else old.resolve(blameLines)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.getByText("new file content")).toBeVisible()
    expect(screen.queryByText(blameLines[0].content)).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    cleanup()
    unlayout()
    uninstall()
  }
})
const picture = (color: string) => ({
  mediaType: "image/svg+xml",
  bytes: 100,
  data: btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${color}"/></svg>`
  )
})
test("image pane: a late image or error for the previous file is ignored (IgnoreLateImage, IgnoreLateError)", async () => {
  const next = { previous: null, current: picture("blue") }
  const src = `data:image/svg+xml;base64,${next.current.data}`
  for (const fail of [false, true]) {
    const old = Promise.withResolvers<ImageDiff>()
    fixtures({ image_diff: args => (args.file === "old.svg" ? old.promise : next) })
    layout(600, 400)
    const view = render(<ImagePane repo={repo} file="old.svg" sha={null} />)
    await waitFor(() =>
      expect(callsOf("image_diff")).toContainEqual(expect.objectContaining({ repo, file: "old.svg" }))
    )
    view.rerender(<ImagePane repo={repo} file="new.svg" sha={null} />)
    expect(await screen.findByRole("img")).toHaveAttribute("src", src)
    if (fail) old.reject(new Error("Old image failed"))
    else old.resolve({ previous: null, current: picture("red") })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.getByRole("img")).toHaveAttribute("src", src)
    expect(screen.queryByText(t("diff.binary"))).not.toBeInTheDocument()
    cleanup()
    unlayout()
    uninstall()
  }
})
const submodule = {
  fullPath: `${repo}/vendor/library`,
  url: "https://gitlab.example/group/library.git",
  recorded: "aaaaaaa",
  actual: "bbbbbbb",
  dirty: 3
}
test("submodule: shows the dirty count and Open opens its path; failures are shown (ChangedAndDirty, Failure)", async () => {
  const user = userEvent.setup()
  fixtures({ submodule_info: () => submodule })
  const onOpen = mock()
  render(<SubmoduleView repo={repo} file={{ ...file, path: "vendor/library" }} onOpen={onOpen} />)
  expect(await screen.findByText(t("submodule.dirty", { count: 3 }))).toBeVisible()
  await user.click(screen.getByRole("button", { name: t("submodule.open") }))
  expect(onOpen).toHaveBeenCalledWith(submodule.fullPath)
  cleanup()
  uninstall()
  fixtures({ submodule_info: unavailable })
  render(<SubmoduleView repo={repo} file={{ ...file, path: "vendor/library" }} onOpen={onOpen} />)
  expect(await screen.findByText(/Preview service unavailable/)).toBeVisible()
})
test("submodule: a late result for the previous path does not retarget Open (IgnoreLateSubmodule)", async () => {
  const user = userEvent.setup()
  const old = Promise.withResolvers<typeof submodule>()
  const next = { ...submodule, fullPath: `${repo}/vendor/next`, url: "https://gitlab.example/group/next.git" }
  fixtures({ submodule_info: args => (args.file === "vendor/library" ? old.promise : next) })
  const onOpen = mock()
  const view = render(<SubmoduleView repo={repo} file={{ ...file, path: "vendor/library" }} onOpen={onOpen} />)
  await waitFor(() => expect(callsOf("submodule_info")).toEqual([{ repo, file: "vendor/library" }]))
  view.rerender(<SubmoduleView repo={repo} file={{ ...file, path: "vendor/next" }} onOpen={onOpen} />)
  await screen.findByText(t("submodule.from", { url: next.url }))
  old.resolve(submodule)
  await new Promise(resolve => setTimeout(resolve, 20))
  await user.click(screen.getByRole("button", { name: t("submodule.open") }))
  expect(onOpen).toHaveBeenCalledWith(next.fullPath)
  expect(onOpen).not.toHaveBeenCalledWith(submodule.fullPath)
})

// ---- Collaboration/Inbox ----
function inbox(
  overrides: Parameters<typeof installNativeFixtures>[0],
  props: Partial<ComponentProps<typeof Inbox>> = {}
) {
  fixtures(overrides)
  openedUrls.length = 0
  const onOpenRepo = mock()
  render(
    <div className="flex h-96 flex-col">
      <Inbox repositories={[repo]} hosts={[]} onOpenRepo={onOpenRepo} {...props} />
    </div>
  )
  return onOpenRepo
}
test("inbox: conflicts and unpushed commits are listed and Go opens the repository (Clear, LocalActions)", async () => {
  const user = userEvent.setup()
  inbox({ repo_summary: () => summary })
  expect(await screen.findByText(t("inbox.clear"))).toBeVisible()
  cleanup()
  uninstall()
  const onOpenRepo = inbox({ repo_summary: () => ({ ...summary, ahead: 2, conflicts: [file.path] }) })
  expect(await screen.findByText(t("inbox.conflict", { count: 1 }))).toBeVisible()
  expect(screen.getByText(t("inbox.unpushed", { count: 2 }))).toBeVisible()
  await user.click(screen.getAllByRole("button", { name: t("inbox.go") })[0])
  expect(onOpenRepo).toHaveBeenCalledWith(repo)
})
test("inbox: a requested GitLab subgroup review opens its merge request page (RemoteReview)", async () => {
  const user = userEvent.setup()
  const url = "https://gitlab.example/group/sub/project/-/merge_requests/42"
  inbox(
    {
      involved_prs: args =>
        args.kind === "reviewRequested" ? [{ number: 42, head: "feature", title: "Review nested groups", url }] : []
    },
    { repositories: [], hosts: ["gitlab.example"] }
  )
  await user.click(await screen.findByRole("button", { name: t("inbox.go") }))
  await waitFor(() => expect(openedUrls).toEqual([url]))
})
test("inbox: a failed summary is an error, not an all-clear, and Refresh recovers (FailureAndRetry)", async () => {
  const user = userEvent.setup()
  let attempts = 0
  inbox({ repo_summary: () => (++attempts === 1 ? unavailable() : summary) })
  expect(await screen.findByRole("alert")).toHaveTextContent("Preview service unavailable")
  expect(screen.queryByText(t("inbox.clear"))).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: t("inbox.refresh") }))
  expect(await screen.findByText(t("inbox.clear"))).toBeVisible()
})

// ---- Discovery/Repositories ----
const project = {
  host: "github.com",
  owner: "nyssance",
  name: "atlas",
  description: "Workspace navigation",
  language: "TypeScript",
  stars: 1,
  private: false,
  fork: false,
  url: "https://github.com/nyssance/atlas"
}
function discover(overrides: Parameters<typeof installNativeFixtures>[0]) {
  fixtures(overrides)
  render(
    <div className="h-96">
      <Discover
        route={{ kind: "mine" }}
        hosts={["github.com"]}
        cloned={new Map()}
        onNavigate={() => {}}
        onOpen={() => {}}
        onCloned={() => {}}
      />
    </div>
  )
}
test("remote repositories: a rate limit is an error, not an empty or signed-out list, and Refresh recovers (RateLimitedAndRetry)", async () => {
  const user = userEvent.setup()
  discover({
    my_repos: args => {
      if (!args.refresh) throw new Error("HTTP 403 Forbidden: API rate limit exceeded")
      return [project]
    }
  })
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(t("errors.rateLimited")))
  expect(screen.queryByText(t("discover.mineEmpty"))).not.toBeInTheDocument()
  expect(screen.queryByText(t("discover.signInHint"))).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: t("discover.refresh") }))
  await waitFor(() => expect(screen.getByText("atlas")).toBeVisible())
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})
test("remote repositories: signed in with no repositories differs from signed out (SignedInEmpty, SignedOut)", async () => {
  discover({ my_repos: () => [] })
  await waitFor(() => expect(screen.getByText(t("discover.mineEmpty"))).toBeVisible())
  expect(screen.queryByText(t("discover.signInHint"))).not.toBeInTheDocument()
  cleanup()
  uninstall()
  discover({
    my_repos: () => {
      throw new Error("github.com 还没登录")
    }
  })
  await waitFor(() => expect(screen.getByText(t("discover.signInHint"))).toBeVisible())
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

test("remote repositories: the Stars tab navigates and loads starred repositories per host (FiltersAndNavigation)", async () => {
  const user = userEvent.setup()
  fixtures({ my_repos: () => [project], my_stars: () => [{ ...project, owner: "tauri-apps", name: "tauri" }] })
  const navigated: string[] = []
  function Window() {
    const [route, setRoute] = useState<{ kind: "mine" | "stars" }>({ kind: "mine" })
    return (
      <div className="h-96">
        <Discover
          route={route}
          hosts={["github.com"]}
          cloned={new Map()}
          onNavigate={uri => {
            navigated.push(uri)
            const kind = new URL(uri).host
            if (kind === "mine" || kind === "stars") setRoute({ kind })
          }}
          onOpen={() => {}}
          onCloned={() => {}}
        />
      </div>
    )
  }
  render(<Window />)
  await waitFor(() => expect(screen.getByText("atlas")).toBeVisible())
  expect(callsOf("my_stars")).toHaveLength(0)
  await user.click(screen.getByRole("tab", { name: t("discover.stars") }))
  expect(navigated).toEqual([routes.stars()])
  await waitFor(() => expect(screen.getByText("tauri")).toBeVisible())
  expect(screen.getByRole("tab", { name: t("discover.stars") })).toHaveAttribute("aria-selected", "true")
  expect(nativeCall).toHaveBeenCalledWith("my_stars", expect.objectContaining({ host: "github.com" }))
  expect(screen.queryByText("atlas")).not.toBeInTheDocument()
})

// ---- Discovery/Trending ----
function trending(overrides: Parameters<typeof installNativeFixtures>[0] = {}) {
  fixtures({
    sync_trending_webview: mockTrendingWebview,
    control_trending_webview: mockTrendingBrowser,
    ...overrides
  })
  layout(800, 600)
  render(
    <div className="h-[600px]">
      <Trending active />
    </div>
  )
}
test("trending: the webview is created visible, Refresh reloads it, and Open in browser hands off (NativeWebpage, Refresh, OpenOnPlatform)", async () => {
  const user = userEvent.setup()
  trending()
  expect(screen.getByRole("button", { name: t("trending.back") })).toBeDisabled()
  expect(screen.getByRole("button", { name: t("trending.forward") })).toBeDisabled()
  await waitFor(() =>
    expect(callsOf("sync_trending_webview")).toContainEqual(
      expect.objectContaining({ frame: expect.objectContaining({ visible: true }) })
    )
  )
  await user.click(await screen.findByRole("button", { name: t("discover.refresh") }))
  await waitFor(() =>
    expect(callsOf("sync_trending_webview")).toContainEqual(
      expect.objectContaining({ reload: true, onLoad: undefined })
    )
  )
  await waitFor(() => expect(screen.queryByLabelText(t("trending.stop"))).not.toBeInTheDocument())
  await user.click(screen.getByRole("button", { name: t("rail.openInBrowser") }))
  expect(callsOf("control_trending_webview")).toContainEqual(expect.objectContaining({ action: "openExternal" }))
})
test("trending: Stop shows while loading; a failed webview shows an alert (Connecting, FailedLoad)", async () => {
  trending({ sync_trending_webview: () => undefined })
  expect(await screen.findByLabelText(t("trending.stop"))).toBeInTheDocument()
  cleanup()
  unlayout()
  uninstall()
  trending({ sync_trending_webview: () => Promise.reject(new Error("Unable to create webview")) })
  expect(await screen.findByRole("alert")).toBeInTheDocument()
})
test("trending: back and forward follow the webview's own history (HistoryNavigation)", async () => {
  const user = userEvent.setup()
  let atRepository = true
  let channel: { onmessage: (message: string) => void } | undefined
  trending({
    sync_trending_webview: args => {
      if (args.onLoad) channel = args.onLoad as typeof channel
      mockTrendingWebview(args)
    },
    control_trending_webview: args => {
      if (args.action === "back" || args.action === "forward") {
        atRepository = args.action === "forward"
        channel?.onmessage("finished")
      }
      return {
        url: atRepository ? "https://github.com/nyssance/atlas" : "https://github.com/trending",
        canGoBack: atRepository,
        canGoForward: !atRepository
      }
    }
  })
  const back = screen.getByRole("button", { name: t("trending.back") })
  const forward = screen.getByRole("button", { name: t("trending.forward") })
  await waitFor(() => expect(back).toBeEnabled())
  expect(forward).toBeDisabled()
  await user.click(back)
  await waitFor(() => expect(forward).toBeEnabled())
  expect(back).toBeDisabled()
  expect(screen.getByText("https://github.com/trending", { exact: true })).toBeVisible()
  await user.click(forward)
  await waitFor(() => expect(back).toBeEnabled())
  expect(forward).toBeDisabled()
  expect(screen.getByText("https://github.com/nyssance/atlas", { exact: true })).toBeVisible()
})

// ---- Changes/File list ----
const changedFiles = ["first.ts", "second.ts", "third.ts"].map(path => ({ ...file, path }))
function ChangedFiles(props: Partial<ComponentProps<typeof ChangesFileList>> & { onSelect: (path: string) => void }) {
  const [selected, select] = useState<string | null>(props.selected ?? changedFiles[0].path)
  const [selectedPaths, selectPaths] = useState<string[]>(selected ? [selected] : [])
  return (
    <div className="h-72">
      <ChangesFileList
        repo="/preview/repository"
        files={changedFiles}
        includeOf={() => DiffSelectionType.All}
        onIncludeChange={() => {}}
        onDiscard={() => {}}
        onBlame={() => {}}
        {...props}
        selected={selected}
        selectedPaths={selectedPaths}
        onSelectionChange={paths => {
          selectPaths(paths)
          const path = paths.at(-1) ?? null
          select(path)
          if (path) props.onSelect(path)
        }}
        onSelect={path => {
          select(path)
          props.onSelect(path)
        }}
      />
    </div>
  )
}
const currentRows = () => screen.getAllByRole("listitem").filter(row => row.getAttribute("aria-current") === "true")
test("changed files: arrows move the selection, Cmd+Down jumps to the end, Space toggles inclusion (KeyboardNavigation)", async () => {
  const user = userEvent.setup()
  layout(300, 288)
  const onSelect = mock()
  const onIncludeChange = mock()
  render(<ChangedFiles onSelect={onSelect} onIncludeChange={onIncludeChange} />)
  ;(await screen.findByText("first.ts")).closest<HTMLElement>('[role="listitem"]')!.focus()
  await user.keyboard("{ArrowDown}")
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith("second.ts"))
  await user.keyboard("{Meta>}{ArrowDown}{/Meta}")
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith("third.ts"))
  await user.keyboard(" ")
  expect(onIncludeChange).toHaveBeenCalledWith("third.ts", false)
})
test("changed files: Shift selects a range, a checkbox toggles only its row, Exclude selected covers the range, Discard selected uses Desktop's menu order (MultipleSelection)", async () => {
  const user = userEvent.setup()
  layout(300, 288)
  const onIncludeChange = mock()
  const onDiscardMany = mock()
  render(<ChangedFiles onSelect={() => {}} onIncludeChange={onIncludeChange} onDiscardMany={onDiscardMany} />)
  await user.click(await screen.findByText("first.ts"))
  await user.keyboard("{Shift>}")
  await user.click(screen.getByText("third.ts"))
  await user.keyboard("{/Shift}")
  expect(currentRows()).toHaveLength(3)
  await user.click(screen.getAllByRole("checkbox")[1])
  expect(onIncludeChange).toHaveBeenCalledTimes(1)
  expect(onIncludeChange).toHaveBeenCalledWith("second.ts", false)
  onIncludeChange.mockClear()
  await user.pointer({ target: screen.getByText("first.ts"), keys: "[MouseRight]" })
  await user.click(screen.getByRole("menuitem", { name: t("changes.excludeSelected") }))
  for (const path of ["first.ts", "second.ts", "third.ts"]) expect(onIncludeChange).toHaveBeenCalledWith(path, false)
  await waitFor(() => expect(currentRows()).toHaveLength(3))
  await user.keyboard("{Meta>}")
  await user.click(screen.getByText("second.ts"))
  await user.keyboard("{/Meta}")
  expect(currentRows()).toHaveLength(2)
  await user.pointer({ target: screen.getByText("first.ts"), keys: "[MouseRight]" })
  const menu = within(screen.getByRole("menu"))
  const labels = menu.getAllByRole("menuitem").map(item => item.textContent)
  expect(labels[0]).toBe(t("changes.menu.discardSelected", { count: 2 }))
  expect(labels).toContain(t("changes.menu.copyPaths"))
  expect(labels.at(-1)).toBe(t("blame.open"))
  await user.click(menu.getByRole("menuitem", { name: t("changes.menu.discardSelected", { count: 2 }) }))
  expect(onDiscardMany).toHaveBeenCalledWith(["first.ts", "third.ts"])
})
test("changed files: native Select All selects every row, then Enter and Space toggle each row's own inclusion (NativeSelectAllAndKeyboardToggle)", async () => {
  const user = userEvent.setup()
  layout(300, 288)
  const onIncludeChange = mock()
  render(
    <ChangedFiles
      onSelect={() => {}}
      onIncludeChange={onIncludeChange}
      includeOf={path => (path === "second.ts" ? DiffSelectionType.None : DiffSelectionType.All)}
    />
  )
  const first = (await screen.findByText("first.ts")).closest<HTMLElement>('[role="listitem"]')!
  first.focus()
  const event = new CustomEvent("select-all", { bubbles: true, cancelable: true })
  first.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  await waitFor(() => expect(currentRows()).toHaveLength(3))
  for (const key of ["{Enter}", " "]) {
    onIncludeChange.mockClear()
    await user.keyboard(key)
    expect(onIncludeChange).toHaveBeenCalledTimes(3)
    expect(onIncludeChange).toHaveBeenCalledWith("first.ts", false)
    expect(onIncludeChange).toHaveBeenCalledWith("second.ts", true)
    expect(onIncludeChange).toHaveBeenCalledWith("third.ts", false)
  }
})

// ---- History/Sidebar ----
const historyCommits = [commit, { ...commit, sha: "b".repeat(40), shortSha: "bbbbbbb", summary: "Initial commit" }]
/** 搜索框默认只开正则，和 GitLens 的 gitCommands.search 默认一致 */
const searchQuery = (query: string, overrides?: Partial<SearchQuery>): SearchQuery => ({
  query,
  matchAll: false,
  matchCase: false,
  matchRegex: true,
  matchWholeWord: false,
  ...overrides
})
const historyFixtures = {
  branches: () => [{ name: "main" }, { name: "release" }],
  search_commits: () => [commit],
  compare_commits: () => ({ ahead: [commit], behind: [historyCommits[1]] })
}
function historySidebar(
  overrides: Parameters<typeof installNativeFixtures>[0] = {},
  props: Partial<ComponentProps<typeof HistorySidebar>> = {}
) {
  fixtures({ ...historyFixtures, ...overrides })
  layout(320, 384)
  const args = {
    commits: historyCommits,
    repo,
    rows: [],
    selected: null,
    currentBranch: "main",
    onSelect: mock(),
    onRevert: mock(),
    onCherryPick: mock(),
    onCherryPickMany: mock(),
    onSquashMany: mock(),
    onCreateTag: mock(),
    onResetTo: mock(),
    onReorder: mock(),
    onMerge: mock(),
    onCompared: mock(),
    ...props
  }
  render(
    <div className="flex h-96 flex-col">
      <HistorySidebar {...(args as ComponentProps<typeof HistorySidebar>)} />
    </div>
  )
  return args
}
const searchBox = () => screen.getByPlaceholderText(t("history.searchPlaceholder"))
const searched = (query: SearchQuery) => ({ repo, query, limit: 100, skip: 0 })
/** 菜单收起动画期间是 pointer-events: none，等它卸掉再点下一个 */
const menuClosed = () => waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument())
async function compareWith(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${t("history.compareWith")}`) }))
  await user.click(await screen.findByRole("menuitemradio", { name }))
  await user.keyboard("{Escape}")
  await menuClosed()
}
test("history: clicking a commit selects it; search sends GitLens defaults and Escape restores history (SelectCommit, SearchAndClear)", async () => {
  const user = userEvent.setup()
  const args = historySidebar()
  await user.click(await screen.findByText(commit.summary))
  expect(args.onSelect).toHaveBeenCalledWith(commit.sha)
  await user.type(searchBox(), "Fix")
  await waitFor(() => expect(callsOf("search_commits")).toContainEqual(searched(searchQuery("Fix"))))
  await waitFor(() => expect(screen.queryByText("Initial commit")).not.toBeInTheDocument())
  await user.keyboard("{Escape}")
  expect(await screen.findByText("Initial commit")).toBeVisible()
})
test("history: :alias: in a commit summary renders as the emoji and the tooltip keeps the shortcode (RichText emoji)", async () => {
  useEmojiStore.setState({ emoji: await readEmoji() })
  try {
    historySidebar({}, { commits: [{ ...commit, summary: ":sparkles: Add search :nope: a:tada:b" }] })
    const row = await screen.findByText("✨ Add search :nope: a:tada:b")
    expect(row).toHaveAttribute("title", ":sparkles: Add search :nope: a:tada:b")
  } finally {
    useEmojiStore.setState({ emoji: new Map() })
  }
})
test("history: match options change the search query (ToggleMatchOptions)", async () => {
  const user = userEvent.setup()
  historySidebar()
  await user.type(searchBox(), "fix")
  await waitFor(() => expect(callsOf("search_commits")).toContainEqual(searched(searchQuery("fix"))))
  for (const option of [t("history.matchCase"), t("history.matchRegex")]) {
    await user.click(screen.getByRole("button", { name: t("history.matchOptions") }))
    await user.click(await screen.findByRole("menuitemcheckbox", { name: option }))
    await user.keyboard("{Escape}")
    await menuClosed()
  }
  await waitFor(() =>
    expect(callsOf("search_commits")).toContainEqual(
      searched(searchQuery("fix", { matchCase: true, matchRegex: false }))
    )
  )
})
test("history: a failed search shows the error and Escape clears it (FailedSearch, ClearFailedSearch)", async () => {
  const user = userEvent.setup()
  historySidebar({ search_commits: unavailable })
  await user.type(searchBox(), "Fix")
  expect(await screen.findByRole("alert")).toHaveTextContent("Preview service unavailable")
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
  expect(await screen.findByText("Initial commit")).toBeVisible()
})
test("history: while a search is pending, commits cannot be dragged to reorder (PendingSearchCannotReorder)", async () => {
  const user = userEvent.setup()
  historySidebar({ search_commits: pending })
  await user.type(searchBox(), "Fix")
  await waitFor(() => expect(callsOf("search_commits")).toContainEqual(searched(searchQuery("Fix"))))
  expect(screen.getByText(commit.summary).closest("[draggable]")).toHaveAttribute("draggable", "false")
  await user.keyboard("{Escape}")
  await waitFor(() =>
    expect(screen.getByText(commit.summary).closest("[draggable]")).toHaveAttribute("draggable", "true")
  )
})
test("history: comparing reports ahead/behind and Merge merges the compared branch (CompareAndMerge)", async () => {
  const user = userEvent.setup()
  const args = historySidebar()
  await compareWith(user, "release")
  await user.click(await screen.findByRole("button", { name: t("history.mergeIn", { branch: "release" }) }))
  expect(args.onMerge).toHaveBeenCalledWith("release")
  expect(args.onCompared).toHaveBeenCalledWith({ ahead: [commit], behind: [historyCommits[1]] })
})
test("history: switching comparison drops the old result and offers no merge until the new one arrives (SwitchingComparison)", async () => {
  const user = userEvent.setup()
  const args = historySidebar({
    branches: () => [{ name: "main" }, { name: "release" }, { name: "next" }],
    compare_commits: args => (args.theirs === "next" ? new Promise<never>(() => {}) : historyFixtures.compare_commits())
  })
  await compareWith(user, "release")
  expect(await screen.findByRole("button", { name: t("history.mergeIn", { branch: "release" }) })).toBeEnabled()
  await compareWith(user, "next")
  await waitFor(() =>
    expect(callsOf("compare_commits")).toContainEqual({ repo, ours: "main", theirs: "next", limit: 200 })
  )
  expect(screen.queryByRole("button", { name: t("history.mergeIn", { branch: "next" }) })).not.toBeInTheDocument()
  expect(args.onCompared).toHaveBeenLastCalledWith(null)
  expect(args.onMerge).not.toHaveBeenCalled()
})
test("history: a failed comparison clears when going back to plain history (ClearFailedComparison)", async () => {
  const user = userEvent.setup()
  historySidebar({ compare_commits: unavailable })
  await compareWith(user, "release")
  expect(await screen.findByRole("alert")).toHaveTextContent("Preview service unavailable")
  await compareWith(user, t("history.noCompare"))
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
  expect(await screen.findByText("Initial commit")).toBeVisible()
})
/** jsdom 没有 DataTransfer；拖拽只用到 setData/getData/types 和两个 effect 字段 */
class TestDataTransfer {
  private entries = new Map<string, string>()
  effectAllowed = "uninitialized"
  dropEffect = "none"
  get types() {
    return [...this.entries.keys()]
  }
  setData(type: string, value: string) {
    this.entries.set(type, value)
  }
  getData(type: string) {
    return this.entries.get(type) ?? ""
  }
}
test("history: dragging selected commits carries them oldest first and a drag cannot drop back on its own list (DragSelectedCommits)", async () => {
  const args = historySidebar()
  const newest = await screen.findByText(commit.summary)
  fireEvent.click(newest)
  fireEvent.click(screen.getByText("Initial commit"), { metaKey: true })
  const row = newest.closest('[draggable="true"]')!
  const data = new TestDataTransfer() as unknown as DataTransfer
  fireEvent.dragStart(row, { dataTransfer: data })
  expect(takeCommitDrag(data, repo)).toEqual([historyCommits[1].sha, commit.sha])
  fireEvent.dragEnd(row, { dataTransfer: data })
  fireEvent.dragStart(row, { dataTransfer: data })
  fireEvent.dragEnd(row, { dataTransfer: data })
  expect(canDropCommits(data, repo)).toBe(false)
  expect(args.onReorder).not.toHaveBeenCalled()
})
test("history: file history selects and closes, reports the end and failures (CloseFileHistory, FailedFileHistory)", async () => {
  const user = userEvent.setup()
  const onCloseFileHistory = mock()
  const args = historySidebar(
    {},
    { fileHistory: { path: "src/main.tsx", commits: [commit], hasMore: false }, onCloseFileHistory }
  )
  expect(await screen.findByRole("status")).toHaveTextContent(t("history.end"))
  expect(screen.queryByText("Initial commit")).not.toBeInTheDocument()
  expect(screen.queryByPlaceholderText(t("history.searchPlaceholder"))).not.toBeInTheDocument()
  await user.click(await screen.findByText(commit.summary))
  expect(args.onSelect).toHaveBeenCalledWith(commit.sha)
  await user.click(screen.getByRole("button", { name: t("history.closeFileHistory") }))
  expect(onCloseFileHistory).toHaveBeenCalledTimes(1)
  cleanup()
  unlayout()
  uninstall()
  historySidebar(
    {},
    {
      fileHistory: { path: "src/main.tsx", commits: [], hasMore: false, error: "Preview service unavailable" },
      onCloseFileHistory
    }
  )
  expect(await screen.findByRole("alert")).toHaveTextContent("Preview service unavailable")
  expect(screen.getByText(t("history.fileHistoryEmpty"))).toBeVisible()
})
const stashSha = "c".repeat(40)
const allRefs = [
  commit,
  { ...commit, sha: stashSha, shortSha: "ccccccc", summary: "On main: wip" },
  { ...commit, sha: "d".repeat(40), shortSha: "ddddddd", summary: "Feature work" },
  historyCommits[1]
]
const graphBase = historyCommits[1].sha
const graphRows = [
  { commit: allRefs[0], lane: 0, lanes: [graphBase], refs: ["main"], head: "main", onHead: true, stash: null },
  { commit: allRefs[1], lane: 1, lanes: [graphBase, graphBase], refs: [], onHead: false, stash: 0 },
  {
    commit: allRefs[2],
    lane: 2,
    lanes: [graphBase, graphBase, graphBase],
    refs: ["feature"],
    onHead: false,
    stash: null
  },
  { commit: allRefs[3], lane: 0, lanes: [], refs: [], onHead: true, stash: null }
]
test("history: stash rows only copy their SHA; commits off HEAD cannot be reordered or reset to (StashAndOtherBranchRows)", async () => {
  const user = userEvent.setup()
  historySidebar({}, { commits: allRefs, rows: graphRows as never })
  const badge = await screen.findByText(t("history.stashBadge", { index: 0 }))
  expect(badge).toHaveAttribute("title", t("history.stashRow", { ref: "stash@{0}", base: graphBase.slice(0, 7) }))
  expect(screen.getByText("On main: wip").closest("[draggable]")).toHaveAttribute("draggable", "false")
  fireEvent.contextMenu(screen.getByText("On main: wip"))
  expect(await screen.findByRole("menuitem", { name: t("history.copySha") })).toBeVisible()
  expect(screen.queryByRole("menuitem", { name: t("history.revertChangesInCommit") })).not.toBeInTheDocument()
  expect(screen.queryByRole("menuitem", { name: t("history.cherryPickCommit") })).not.toBeInTheDocument()
  await user.keyboard("{Escape}")
  await menuClosed()
  fireEvent.contextMenu(screen.getByText("Feature work"))
  expect(await screen.findByRole("menuitem", { name: t("history.cherryPickCommit") })).toBeVisible()
  expect(screen.getByRole("menuitem", { name: t("history.reorderCommit") })).toHaveAttribute("aria-disabled", "true")
  expect(screen.getByRole("menuitem", { name: t("history.resetToCommit") })).toHaveAttribute("aria-disabled", "true")
})
test("history: Escape cancels keyboard reorder; arrows and Enter reorder by HEAD-history position (StashAndOtherBranchRows)", async () => {
  const user = userEvent.setup()
  const args = historySidebar({}, { commits: allRefs, rows: graphRows as never })
  fireEvent.contextMenu(await screen.findByText(commit.summary))
  await user.click(await screen.findByRole("menuitem", { name: t("history.reorderCommit") }))
  expect(await screen.findByText(t("history.reorderCommits"))).toBeVisible()
  await user.keyboard("{Escape}")
  await menuClosed()
  await waitFor(() => expect(screen.queryByText(t("history.reorderCommits"))).not.toBeInTheDocument())
  expect(args.onReorder).not.toHaveBeenCalled()
  fireEvent.contextMenu(screen.getByText(commit.summary))
  await user.click(await screen.findByRole("menuitem", { name: t("history.reorderCommit") }))
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}")
  // 第 2 行是 feature 上的提交，不在 HEAD 历史里：插入位置落到它后面第一条 HEAD 提交（HEAD 历史第 1 条）
  expect(args.onReorder).toHaveBeenCalledWith([commit.sha], 1)
})

// ---- Changes/Mention autocompletion ----
const mentionable: IMentionableUser[] = [
  { login: "octocat", name: "The Octocat", email: "octocat@users.noreply.github.com", avatarURL: "" },
  { login: "hubot", name: "Hubot", email: "hubot@users.noreply.github.com", avatarURL: "" },
  { login: "monalisa", name: "Mona Octo", email: "mona@example.test", avatarURL: "" }
]
const mentionProvider = (host: string, gitlab: boolean) =>
  new UserAutocompletionProvider(
    mentionableUsersSource(mentionable, { getByLogin: async () => null }),
    completionRepository({ host, owner: "gitcub", name: "gitcub" }, gitlab)
  )
const logins = async (provider: UserAutocompletionProvider, text: string) =>
  (await provider.getAutocompletionItems(text)).map(hit => hit.username)
test("emoji: the gemoji table keys every alias as :alias: and highlights the typed part", async () => {
  const emoji = await readEmoji()
  expect(emoji.size).toBeGreaterThan(1800)
  expect(emoji.get(":+1:")?.emoji).toBe("👍")
  expect(emoji.get(":thumbsup:")?.emoji).toBe("👍")
  const provider = new EmojiAutocompletionProvider(emoji)
  const [hit] = await provider.getAutocompletionItems("smil")
  expect(hit).toMatchObject({ title: ":smile:", emoji: "😄" })
  expect(provider.getCompletionText(hit!)).toBe("😄")
  render(provider.renderItem(hit!))
  expect(document.querySelector(".title mark")?.textContent).toBe("smil")
  expect(document.querySelector(".title")?.textContent).toBe("smile")
})
test("mentions: login matches rank before name matches and non-matches are left out (MatchesLoginAndName)", async () => {
  expect(await logins(mentionProvider("github.com", false), "octo")).toEqual(["octocat", "monalisa"])
})
test("mentions: typing @ opens the list without stealing focus and ↓ Enter inserts the login (MatchesLoginAndName)", async () => {
  const user = userEvent.setup()
  const provider = mentionProvider("github.com", false)
  function Description() {
    const [value, setValue] = useState("")
    return (
      <AutocompletingTextArea
        value={value}
        onValueChanged={setValue}
        autocompletionProviders={[provider as never]}
        screenReaderLabel="Commit description"
      />
    )
  }
  render(<Description />)
  const input = screen.getByRole("combobox", { name: "Commit description" })
  await user.type(input, "Thanks @octo")
  // Desktop 的补全弹层 trapFocus={false}：弹出后焦点仍在输入框（弹层抢焦点的回归由原生用例覆盖，jsdom 复现不稳定）
  await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"))
  expect(input).toHaveFocus()
  // 候选顺序见下一条（octocat 用户名命中排在 monalisa 真名命中之前）；虚拟列表在 jsdom 下不渲染行
  // Desktop onKeyDown：Enter 只插入已选中的候选（selectedItem 初始为 null），先按 ↓ 选中第一行
  await user.keyboard("{ArrowDown}{Enter}")
  await waitFor(() => expect(input).toHaveValue("Thanks @octocat "))
  expect(input).toHaveAttribute("aria-expanded", "false")
})
test("mentions: github.com offers @Copilot, GitLab does not (DotComOffersCopilot, GitLabHasNoCopilot)", async () => {
  expect(await logins(mentionProvider("github.com", false), "cop")).toContain("Copilot")
  expect(await logins(mentionProvider("gitlab.example", true), "hub")).toEqual(["hubot"])
  expect(await logins(mentionProvider("gitlab.example", true), "cop")).not.toContain("Copilot")
})
test("co-authors: a typed GitLab username resolves through the platform with its API endpoint (GitLabResolvesTypedCoAuthor)", async () => {
  const repository = completionRepository({ host: "gitlab.example", owner: "gitcub", name: "gitcub" }, true)
  const dev = { login: "dev", name: "Dev", email: "42-dev@users.noreply.gitlab.example", avatarURL: "" }
  const resolving = new CoAuthorAutocompletionProvider(
    mentionableUsersSource(mentionable, { getByLogin: async () => null }, async login =>
      login === "dev" ? dev : null
    ),
    repository
  )
  expect(await resolving.exactMatch("dev")).toEqual({
    kind: "known-user",
    username: "dev",
    name: "Dev",
    email: "42-dev@users.noreply.gitlab.example",
    endpoint: "https://gitlab.example/api/v4"
  })
  expect(await resolving.exactMatch("nobody")).toBeNull()
  const original = new CoAuthorAutocompletionProvider(
    mentionableUsersSource(mentionable, { getByLogin: async () => null }),
    repository
  )
  expect(await original.exactMatch("dev")).toBeNull()
})

// ---- CI/Refresh、CI/Job steps ----
const buildRun: IRefCheck = {
  id: 1,
  name: "Build",
  description: "Failed",
  appName: "GitHub Actions",
  status: APICheckStatus.Completed,
  conclusion: APICheckConclusion.Failure,
  checkSuiteId: 1,
  htmlUrl: "https://github.com/example/project/actions/runs/1",
  actionJobSteps: [
    {
      name: "Compile",
      number: 1,
      status: APICheckStatus.Completed,
      conclusion: APICheckConclusion.Failure,
      started_at: "",
      completed_at: "",
      log: ""
    }
  ]
}
test("CI: a refresh keeps the user's collapse, adds new jobs collapsed and drops removed ones (PreservesUserExpansion)", async () => {
  const user = userEvent.setup()
  const list = (runs: readonly IRefCheck[]) => (
    <div className="desktop-ci-popover">
      <CICheckRunList checkRuns={runs} />
    </div>
  )
  const view = render(list([buildRun]))
  const build = () => screen.getByRole("button", { name: /Build/ })
  expect(build()).toHaveAttribute("aria-expanded", "true")
  await user.click(build())
  view.rerender(
    list([
      { ...buildRun, actionJobSteps: [{ ...buildRun.actionJobSteps![0], name: "Updated step" }] },
      { ...buildRun, id: 2, name: "New job" }
    ])
  )
  expect(build()).toHaveAttribute("aria-expanded", "false")
  expect(screen.getByRole("button", { name: /New job/ })).toBeInTheDocument()
  await user.click(build())
  expect(within(screen.getByRole("region", { name: "Build" })).getByText("Updated step")).toBeInTheDocument()
  view.rerender(list([{ ...buildRun, id: 2, name: "New job" }]))
  expect(screen.queryByRole("button", { name: /Build/ })).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: /New job/ })).toHaveAttribute("aria-expanded", "false")
})
test("CI: clicking a job step hands that step to the viewer (OpenStepOnPlatform)", async () => {
  const user = userEvent.setup()
  const steps: IAPIWorkflowJobStep[] = ["Checkout", "Typecheck", "Build"].map((name, index) => ({
    name,
    number: index + 1,
    status: APICheckStatus.Completed,
    conclusion: APICheckConclusion.Success,
    started_at: "2026-01-01T12:00:00Z",
    completed_at: "2026-01-01T12:00:10Z",
    log: ""
  }))
  const onViewJobStep = mock()
  render(<CICheckRunActionsJobStepList steps={steps} onViewJobStep={onViewJobStep} />)
  await user.click(screen.getAllByRole("link")[1])
  expect(onViewJobStep).toHaveBeenCalledWith(steps[1])
})

// ---- Repositories/Navigation ----
function repositoryRail(props: Partial<ComponentProps<typeof RepositoryRail>> = {}) {
  fixtures()
  const onNavigate = mock()
  render(
    <div className="h-[620px] w-60">
      <RepositoryRail
        repositories={[
          "/preview/gitcub",
          "/preview/atlas",
          "/preview/very-long-repository-name-for-truncation",
          "/preview/team"
        ]}
        current="/preview/gitcub"
        route={{ kind: "repo" }}
        remotes={{
          "/preview/gitcub": { host: "github.com", owner: "nyssance", name: "gitcub" },
          "/preview/atlas": { host: "github.com", owner: "nyssance", name: "atlas" },
          "/preview/team": { host: "gitlab.example", owner: "team/subgroup", name: "team" }
        }}
        accounts={{
          "github.com": { kind: "github", login: "nyssance", owners: ["nyssance"], source: "settings", ignored: false },
          "gitlab.example": { kind: "gitlab", login: "ny", owners: ["team"], source: "settings", ignored: false }
        }}
        author={{ name: "NY", email: "" }}
        ownership={{}}
        onNavigate={onNavigate}
        onAdd={() => {}}
        onNewRepo={() => {}}
        onOwnershipChange={() => {}}
        onSyncUpstream={() => {}}
        {...props}
      />
    </div>
  )
  return onNavigate
}
test("repository rail: cached rows need no native calls, platform tabs split rows, a row navigates (NavigationAndTabs, CachedOwnershipSurvivesReadFailure)", async () => {
  const user = userEvent.setup()
  const onNavigate = repositoryRail({ remoteErrors: { "/preview/gitcub": "Unable to read origin" } })
  expect(screen.getByRole("tab", { name: "GitHub" })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByRole("button", { name: "gitcub" })).toBeVisible()
  expect(screen.queryByText(t("rail.signedOutTitle"))).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "gitcub" }).querySelector("svg")).toBeNull()
  expect(screen.queryByRole("button", { name: "team" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "atlas" }))
  expect(onNavigate).toHaveBeenCalledWith(routes.repo("/preview/atlas"))
  await user.click(screen.getByRole("tab", { name: "GitLab" }))
  expect(await screen.findByRole("button", { name: "team" })).toBeVisible()
  await user.click(screen.getByRole("tab", { name: t("rail.other") }))
  expect(await screen.findByRole("button", { name: "very-long-repository-name-for-truncation" })).toBeVisible()
  expect(nativeCall).not.toHaveBeenCalled()
})
test("repository rail: an empty GitHub tab stays selected instead of switching to Other (EmptyGitHubStaysSelected)", async () => {
  const user = userEvent.setup()
  repositoryRail({ accounts: {}, remotes: {} })
  expect(screen.getByRole("tab", { name: "GitHub" })).toHaveAttribute("aria-selected", "true")
  expect(screen.queryByRole("button", { name: "gitcub" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("tab", { name: t("rail.other") }))
  expect(await screen.findByRole("button", { name: "gitcub" })).toBeVisible()
})

// ---- Settings/Navigation：在设置里导入本机 Desktop ----
const preferencesState = {
  repositories: [],
  selectedRepository: null,
  sidebarWidth: 250,
  selectedTab: "changes",
  theme: "system",
  language: "",
  repoOwnership: {},
  accountHosts: [],
  oauthClients: {}
}
function preferences(overrides: Parameters<typeof installNativeFixtures>[0], state = {}) {
  fixtures(overrides)
  const onPatch = mock()
  render(
    <Preferences
      open
      initialTab="advanced"
      onOpenChange={() => {}}
      onPatch={onPatch}
      onAccountsChanged={() => {}}
      hosts={["github.com", "gitlab.com"]}
      accounts={{}}
      state={{ ...preferencesState, ...state } as never}
    />
  )
  return onPatch
}
test("preferences: importing Desktop merges repositories and reports imported and skipped counts (ImportLocalDesktop)", async () => {
  const user = userEvent.setup()
  const onPatch = preferences(
    {
      read_desktop_import: () => ({
        repositories: ["/existing", "/imported"],
        selectedRepository: "/imported",
        theme: "dark",
        sidebarWidth: 280,
        externalEditor: "com.microsoft.VSCode",
        externalTerminal: "com.apple.Terminal",
        skipped: ["/missing"]
      })
    },
    { repositories: ["/existing"], selectedRepository: "/existing" }
  )
  await user.click(await screen.findByRole("button", { name: t("prefs.desktopImportAction") }))
  await waitFor(() =>
    expect(onPatch).toHaveBeenCalledWith({
      accountHosts: [],
      desktopImportHandled: true,
      repositories: ["/existing", "/imported"],
      theme: "dark",
      sidebarWidth: 280,
      externalEditor: "com.microsoft.VSCode",
      externalTerminal: "com.apple.Terminal"
    })
  )
  expect(screen.getByRole("status")).toHaveTextContent(t("prefs.desktopImported", { count: 1, skipped: 1 }))
})
test("preferences: a failed Desktop import patches nothing and can be retried (ImportLocalDesktopFailure)", async () => {
  const user = userEvent.setup()
  const onPatch = preferences({
    read_desktop_import: () => {
      throw new Error("Desktop storage changed. Retry after quitting Desktop.")
    }
  })
  const button = await screen.findByRole("button", { name: t("prefs.desktopImportAction") })
  await user.click(button)
  expect(await screen.findByRole("alert")).toHaveTextContent("Desktop storage changed")
  expect(onPatch).not.toHaveBeenCalled()
  expect(button).toBeEnabled()
  await user.click(button)
  await waitFor(() => expect(callsOf("read_desktop_import")).toHaveLength(2))
})
test("preferences: a pending Desktop import runs once and disables the button (ImportLocalDesktopBusy)", async () => {
  const user = userEvent.setup()
  preferences({ read_desktop_import: pending })
  await user.click(await screen.findByRole("button", { name: t("prefs.desktopImportAction") }))
  expect(await screen.findByRole("button", { name: t("prefs.desktopImporting") })).toBeDisabled()
  expect(callsOf("read_desktop_import")).toHaveLength(1)
})

// ---- Diff/Image ----
// 解码失败（LoadFailure / RecoverAfterLoadFailure）要真实解码图片，jsdom 不加载图片，这两条只在原生 WebKit 里验证
const svgPicture = (color: string, bytes: number) => ({
  mediaType: "image/svg+xml",
  bytes,
  data: btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="${color}"/></svg>`
  )
})
test("image diff: every mode shows both revisions and only swipe and onion have a slider (ComparisonModes)", async () => {
  const user = userEvent.setup()
  layout(600, 384)
  render(<ImageDiffView data={{ previous: svgPicture("#155e75", 140), current: svgPicture("#1d4ed8", 160) }} />)
  for (const mode of ["swipe", "onion", "difference", "two-up"]) {
    await user.click(screen.getByRole("button", { name: t(`diff.image_${mode}`) }))
    expect(screen.getByRole("img", { name: t("diff.imageBefore") })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: t("diff.imageAfter") })).toBeInTheDocument()
    if (mode === "swipe" || mode === "onion") {
      const slider = screen.getByRole("slider")
      expect(slider).toHaveAttribute("aria-valuenow", mode === "swipe" ? "0" : "1")
      slider.focus()
      await user.keyboard("{ArrowRight}")
      expect(slider).toHaveAttribute("aria-valuenow", mode === "swipe" ? "0.1" : "1.1")
      await user.keyboard("{ArrowLeft}")
    } else expect(screen.queryByRole("slider")).not.toBeInTheDocument()
  }
})
test("image diff: slider ends map to clip and opacity, and each mode starts from its own default (SliderEndpointsAndModeReset)", async () => {
  const user = userEvent.setup()
  layout(600, 384)
  render(<ImageDiffView data={{ previous: svgPicture("#155e75", 140), current: svgPicture("#1d4ed8", 160) }} />)
  const select = async (mode: string) => {
    const button = screen.getByRole("button", { name: t(`diff.image_${mode}`) })
    await user.click(button)
    expect(button).toHaveAttribute("aria-pressed", "true")
  }
  const before = () => screen.getByRole("img", { name: t("diff.imageBefore") }).parentElement!
  // jsdom 31 把内联样式里的 0 序列化成 0px，和浏览器一致；比较前归一化
  const clip = () => before().style.clipPath.replaceAll("0px", "0")
  await select("swipe")
  let slider = screen.getByRole("slider")
  slider.focus()
  await user.keyboard("{End}")
  expect(slider).toHaveAttribute("aria-valuenow", "100")
  expect(clip()).toBe("inset(0 0% 0 0)")
  await user.keyboard("{Home}")
  expect(slider).toHaveAttribute("aria-valuenow", "0")
  expect(clip()).toBe("inset(0 100% 0 0)")
  await select("onion")
  slider = screen.getByRole("slider")
  expect(slider).toHaveAttribute("aria-valuenow", "1")
  const after = screen.getByRole("img", { name: t("diff.imageAfter") }).parentElement!
  expect(after.style.opacity).toBe("0.01")
  slider.focus()
  await user.keyboard("{End}")
  expect(after.style.opacity).toBe("1")
  await user.keyboard("{Home}")
  expect(after.style.opacity).toBe("0")
  await select("two-up")
  await select("onion")
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "1")
  await select("swipe")
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "0")
})

// ---- Diff/Split ----
test("split diff: Space on one line's checkbox toggles only that line (Selectable)", async () => {
  const user = userEvent.setup()
  layout(800, 384)
  const diff = new DiffParser().parse(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n-oldValue\n+newValue\n+extraValue\n sameValue\n"
  )
  const onChange = mock<(selection: DiffSelection) => void>()
  render(
    <div className="flex h-96 flex-col">
      <SplitDiff
        diff={diff}
        selection={DiffSelection.fromInitialSelection(DiffSelectionType.All)}
        onChange={onChange}
        wrap={false}
        query=""
        searchStep={0}
      />
    </div>
  )
  ;(await screen.findByRole("checkbox", { name: "Line 1 added" })).focus()
  await user.keyboard(" ")
  await waitFor(() => expect(onChange).toHaveBeenCalled())
  const selection = onChange.mock.calls.at(-1)![0]
  expect(selection.isSelected(1)).toBe(true)
  expect(selection.isSelected(2)).toBe(false)
  expect(selection.isSelected(3)).toBe(true)
})

test("split diff: Escape during a gutter drag cancels it and mouseup commits nothing (CancelDragWithEscape)", async () => {
  layout(800, 384)
  const diff = new DiffParser().parse(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n-oldValue\n+newValue\n+extraValue\n sameValue\n"
  )
  const onChange = mock<(selection: DiffSelection) => void>()
  const { container } = render(
    <div className="flex h-96 flex-col">
      <SplitDiff
        diff={diff}
        selection={DiffSelection.fromInitialSelection(DiffSelectionType.All)}
        onChange={onChange}
        wrap={false}
        query=""
        searchStep={0}
      />
    </div>
  )
  const line = await screen.findByRole("checkbox", { name: "Line 1 added" })
  fireEvent.mouseDown(line.closest(".line-number")!, { button: 0 })
  fireEvent.keyDown(container.querySelector(".side-by-side-diff-container")!, { key: "Escape" })
  fireEvent.mouseUp(document)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(onChange).not.toHaveBeenCalled()
  expect(line).toBeChecked()
  // 对照：不按 Escape 时同一次拖选在 mouseup 提交，取消选中这一行
  fireEvent.mouseDown(line.closest(".line-number")!, { button: 0 })
  fireEvent.mouseUp(document)
  await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
  // 「Line 1 added」是 diff 第 2 行（前面是 hunk 头和删除行）
  expect(onChange.mock.calls[0][0].isSelected(2)).toBe(false)
  expect(onChange.mock.calls[0][0].isSelected(1)).toBe(true)
})

// ---- Changes/Banner、History/Commit files ----
test("banner: the action runs without dismissing, and dismiss only dismisses (Undo, Dismiss)", async () => {
  const user = userEvent.setup()
  const onDismiss = mock()
  const onAction = mock()
  const view = render(
    <Banner message="Committed 3 files" sticky actionLabel="Undo" onDismiss={onDismiss} onAction={onAction} />
  )
  await user.click(screen.getByRole("button", { name: "Undo" }))
  expect(onAction).toHaveBeenCalledTimes(1)
  expect(onDismiss).not.toHaveBeenCalled()
  view.rerender(<Banner message="Committed 3 files" sticky onDismiss={onDismiss} onAction={onAction} />)
  await user.click(screen.getByRole("button", { name: "dismiss" }))
  expect(onDismiss).toHaveBeenCalledTimes(1)
  expect(onAction).toHaveBeenCalledTimes(1)
})
test("commit files: clicking a file selects it (AllStatuses)", async () => {
  const user = userEvent.setup()
  layout(300, 288)
  const files: CommitFile[] = ["added", "modified", "deleted", "renamed", "copied"].map((kind, index) => ({
    path: `${kind}-${index}.ts`,
    kind: kind as CommitFile["kind"],
    oldPath: kind === "renamed" ? "old.ts" : null,
    renameIncludesModifications: false,
    submodule: false,
    linesAdded: index,
    linesDeleted: 0
  }))
  const onSelect = mock()
  render(
    <div className="h-72">
      <CommitFileList files={files} selected={files[0].path} onSelect={onSelect} />
    </div>
  )
  await user.click(await screen.findByText(files[1].path))
  expect(onSelect).toHaveBeenCalledWith(files[1].path)
})

// ---- Diff/Working file ----
const workingPatch =
  "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -4,5 +4,5 @@\n context4\n-old5\n+new5\n context6\n-old7\n+new7\n context8\n"
const workingDiff = new DiffParser().parse(workingPatch)
const workingContents = "context1\ncontext2\ncontext3\ncontext4\nnew5\ncontext6\nnew7\ncontext8\ncontext9\n"
function WorkingDiff(props: Partial<ComponentProps<typeof DiffView>> & { file?: string }) {
  const [selection, setSelection] = useState(props.selection ?? initialSelection(props.diff ?? workingDiff))
  return (
    <div className="flex h-96 flex-col">
      <DiffView
        repo="/fixture"
        file="a.txt"
        diff={workingDiff}
        error={null}
        onDiscardLines={() => {}}
        {...props}
        selection={selection}
        onSelectionChange={value => {
          setSelection(value)
          props.onSelectionChange?.(value)
        }}
      />
    </div>
  )
}
function workingFile(overrides: Parameters<typeof installNativeFixtures>[0] = {}) {
  localStorage.setItem("diff-layout", "unified")
  fixtures({
    file_contents: () => ({ modified: workingContents }),
    repo_status: () => ({ changes: [{ path: "a.txt", kind: "unstaged", change: "modified" }] }),
    working_directory_diff: () => ({ text: workingPatch, lineEndings: null }),
    ...overrides
  })
  layout(800, 384)
}
const lineLabel = async (name: string) =>
  (await screen.findByRole("checkbox", { name })).closest(".line-number")!.querySelector("label")!
const rightClick = (user: ReturnType<typeof userEvent.setup>, target: Element) =>
  user.pointer({ target, keys: "[MouseRight]" })
test("working diff: Discard hunk discards only the contiguous block (DiscardOnlyContiguousBlock)", async () => {
  const user = userEvent.setup()
  workingFile()
  const onDiscardLines = mock()
  render(<WorkingDiff onDiscardLines={onDiscardLines} />)
  await rightClick(user, await lineLabel("Line 5 added"))
  await user.click(await screen.findByRole("menuitem", { name: t("diff.discardHunk") }))
  expect(onDiscardLines).toHaveBeenCalledWith(workingDiff, [2, 3])
})
test("working diff: a blank-area menu does not keep the previous line as its target (ClearContextOnBlankArea)", async () => {
  const user = userEvent.setup()
  workingFile()
  const onDiscardLines = mock()
  const view = render(<WorkingDiff onDiscardLines={onDiscardLines} />)
  await rightClick(user, await lineLabel("Line 5 added"))
  await user.keyboard("{Escape}")
  await menuClosed()
  await rightClick(user, view.container.querySelector(".unified-diff")!)
  expect(await screen.findByRole("menuitem", { name: t("diff.discardLine") })).toHaveAttribute("aria-disabled", "true")
  expect(onDiscardLines).not.toHaveBeenCalled()
})
test("working diff: after expanding, Space and Discard hunk use canonical line indexes; collapse resets (ExpandSelectDiscardAndCollapse)", async () => {
  const user = userEvent.setup()
  workingFile()
  const onDiscardLines = mock()
  const onSelectionChange = mock()
  const view = render(<WorkingDiff onDiscardLines={onDiscardLines} onSelectionChange={onSelectionChange} />)
  await rightClick(user, await screen.findByRole("button", { name: "Expand Up" }))
  await user.click(await screen.findByRole("menuitem", { name: t("diff.expandAll") }))
  await menuClosed()
  expect(await screen.findByText("context1")).toBeVisible()
  const line = screen.getByRole("checkbox", { name: "Line 7 added" })
  line.focus()
  await user.keyboard(" ")
  await waitFor(() => expect(onSelectionChange).toHaveBeenCalled())
  const next = onSelectionChange.mock.calls.at(-1)![0]
  expect(next.isSelected(6)).toBe(false)
  expect(next.isSelected(3)).toBe(true)
  await rightClick(user, line.closest(".line-number")!.querySelector("label")!)
  await user.click(await screen.findByRole("menuitem", { name: t("diff.discardHunk") }))
  expect(onDiscardLines).toHaveBeenCalledWith(workingDiff, [5, 6])
  await menuClosed()
  await rightClick(user, view.container.querySelector(".unified-diff")!)
  await user.click(await screen.findByRole("menuitem", { name: t("diff.collapse") }))
  await waitFor(() => expect(screen.queryByText("context1")).not.toBeInTheDocument())
  expect(screen.getByRole("checkbox", { name: "Line 7 added" })).not.toBeChecked()
})
test("working diff: with whitespace hidden, lines cannot be discarded and selecting asks to show whitespace (FilteredDiffCannotDiscard, WhitespaceSelectionGuard)", async () => {
  const user = userEvent.setup()
  workingFile()
  const onDiscardLines = mock()
  const onSelectionChange = mock()
  render(<WorkingDiff onDiscardLines={onDiscardLines} onSelectionChange={onSelectionChange} />)
  // Desktop 的空白开关在 diff 选项弹层里
  await user.click(screen.getByRole("button", { name: t("diff.settings") }))
  await user.click(await screen.findByRole("checkbox", { name: t("diff.hideWhitespace") }))
  await user.keyboard("{Escape}")
  await rightClick(user, await lineLabel("Line 5 added"))
  expect(await screen.findByRole("menuitem", { name: t("diff.discardLine") })).toHaveAttribute("aria-disabled", "true")
  await user.keyboard("{Escape}")
  await menuClosed()
  expect(onDiscardLines).not.toHaveBeenCalled()
  await user.click(await lineLabel("Line 5 added"))
  const dialog = await screen.findByRole("dialog")
  expect(dialog).toHaveTextContent(t("diff.whitespaceBody"))
  expect(onSelectionChange).not.toHaveBeenCalled()
  await user.click(within(dialog).getByRole("button", { name: t("diff.showWhitespace") }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  await user.click(screen.getByRole("button", { name: t("diff.settings") }))
  expect(await screen.findByRole("checkbox", { name: t("diff.hideWhitespace") })).not.toBeChecked()
})
test("working diff: a failed expansion shows the error and can be retried (ExpansionFailureCanRetry)", async () => {
  const user = userEvent.setup()
  let calls = 0
  workingFile({
    file_contents: () => {
      if (calls++ === 0) throw new Error("Read failed")
      return { modified: workingContents }
    }
  })
  render(<WorkingDiff />)
  await user.click(await screen.findByRole("button", { name: "Expand Up" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Read failed")
  await user.click(screen.getByRole("button", { name: "Expand Up" }))
  expect(await screen.findByText("context1")).toBeVisible()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(callsOf("file_contents")).toHaveLength(2)
})
test("working diff: an expansion that finishes after switching files is ignored (IgnoreExpansionAfterFileSwitch)", async () => {
  const user = userEvent.setup()
  const contents = Promise.withResolvers<{ modified: string }>()
  workingFile({ file_contents: () => contents.promise })
  const view = render(<WorkingDiff />)
  await user.click(await screen.findByRole("button", { name: "Expand Up" }))
  view.rerender(<WorkingDiff file="b.txt" />)
  contents.resolve({ modified: workingContents })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(screen.queryByText("context1")).not.toBeInTheDocument()
})
test("diff search: ⌘F opens search, Enter and Shift+Enter step through every match, no match is announced (SearchEveryOccurrence)", async () => {
  const user = userEvent.setup()
  workingFile()
  const view = render(
    <WorkingDiff
      readOnly
      diff={new DiffParser().parse(
        "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+word word\n"
      )}
    />
  )
  // Desktop side-by-side-diff：⌘F 才弹出搜索框，回车才搜，同一个词再回车跳下一处，⇧ 回车上一处
  await user.keyboard("{Meta>}f{/Meta}")
  const search = await screen.findByPlaceholderText(t("diffSearchInput.search"))
  await user.type(search, "word{Enter}")
  const result = (current: number, total: number) =>
    t("diffSearchInput.resultCurrentOfTotalForQuery", { current, total, query: "word" })
  expect(await screen.findByText(result(1, 2))).toBeInTheDocument()
  const first = view.container.querySelector(".cm-search-result-current")
  expect(first).toHaveTextContent("word")
  await user.keyboard("{Enter}")
  expect(await screen.findByText(result(2, 2))).toBeInTheDocument()
  expect(view.container.querySelector(".cm-search-result-current")).not.toBe(first)
  await user.keyboard("{Shift>}{Enter}{/Shift}")
  expect(await screen.findByText(result(1, 2))).toBeInTheDocument()
  await user.clear(search)
  await user.type(search, "absent{Enter}")
  expect(await screen.findByText(t("diffSearchInput.noResultsForQuery", { query: "absent" }))).toBeInTheDocument()
})

// ---- Toolbar/Branch dropdown ----
const branchSha = (n: number) => String(n).repeat(40).slice(0, 40)
const localBranch = (name: string, n: number, upstream: string | null = null) => ({
  name,
  upstream,
  sha: branchSha(n),
  remote: false,
  reference: `refs/heads/${name}`
})
const remoteBranch = (name: string, n: number) => ({
  name,
  upstream: null,
  sha: branchSha(n),
  remote: true,
  reference: `refs/remotes/${name}`
})
function branchDropdown() {
  fixtures({
    branch_details: () => [
      localBranch("main", 1, "origin/main"),
      localBranch("codex/vendor-parity", 2),
      remoteBranch("origin/main", 1)
    ],
    recent_branches: () => ["main", "codex/vendor-parity"],
    remotes: () => [["origin", "https://github.com/nyssance/gitcub.git"]],
    get_remote_head: () => "main",
    get_config_value: () => null,
    worktrees: () => [],
    branch_policy: () => null,
    repo_status: () => ({ ...repoStatus, branch: "main" }),
    git_execute: () => ({ exitCode: 0, stdout: "", stderr: "", path: repo, gitError: null, gitErrorDescription: null })
  })
  layout(900, 400)
  const args = {
    onCheckout: mock(async () => {}),
    onMerge: mock(async () => {})
  }
  render(
    <div className="flex h-12 w-[900px]">
      <BranchDropdown
        repo={repo}
        branch="main"
        onCreate={async () => {}}
        onDelete={async () => {}}
        onRebase={async () => {}}
        onRename={() => {}}
        onWorktrees={() => {}}
        onOpenWorktree={() => {}}
        {...args}
      />
    </div>
  )
  return args
}
async function openBranches(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /main/ }))
  await screen.findByText(t("desktopUI.defaultBranch"))
}
test("branch dropdown: clicking a branch checks it out (CheckoutFromList)", async () => {
  const user = userEvent.setup()
  const args = branchDropdown()
  await openBranches(user)
  await user.click(await screen.findByText("codex/vendor-parity"))
  expect(args.onCheckout).toHaveBeenCalledWith("codex/vendor-parity")
})
test("branch dropdown: in merge mode a click merges into the current branch and does not check out (MergeIntoCurrent)", async () => {
  const user = userEvent.setup()
  const args = branchDropdown()
  await openBranches(user)
  await user.click(screen.getByRole("button", { name: new RegExp(t("desktopUI.chooseBranchToMergeInto")) }))
  await user.click(await screen.findByText("codex/vendor-parity"))
  expect(args.onMerge).toHaveBeenCalledWith("refs/heads/codex/vendor-parity", false)
  expect(args.onCheckout).not.toHaveBeenCalled()
})

// ---- 链接点开浏览器：History/Commit summary、History/Rich text ----
test("commit summary: issue links open in the browser on GitHub and in GitLab subgroups; abc#5 is not linked (GitHubIssueLinks, GitLabSubgroup)", async () => {
  const user = userEvent.setup()
  openedUrls.length = 0
  const view = render(
    <CommitSummary commit={commit} remote={{ host: "github.com", owner: "gitcub", name: "gitcub" }} />
  )
  await user.click(screen.getByRole("link", { name: "#42" }))
  await waitFor(() => expect(openedUrls).toEqual(["https://github.com/gitcub/gitcub/issues/42"]))
  expect(screen.queryByRole("link", { name: "#5" })).not.toBeInTheDocument()
  view.rerender(
    <CommitSummary
      commit={{ ...commit, body: "Merge !12 after #123; literal abc#5." }}
      remote={{ host: "gitlab.example", owner: "group/subgroup", name: "project" }}
      platform="gitlab"
    />
  )
  await user.click(screen.getByRole("link", { name: "#42" }))
  await waitFor(() => expect(openedUrls.at(-1)).toBe("https://gitlab.example/group/subgroup/project/-/issues/42"))
  expect(screen.getByRole("link", { name: "!12" })).toHaveAttribute(
    "href",
    "https://gitlab.example/group/subgroup/project/-/merge_requests/12"
  )
  expect(screen.queryByRole("link", { name: "#5" })).not.toBeInTheDocument()
})
test("rich text: a custom autolink opens in the browser (CustomRuleAndGitLab)", async () => {
  const user = userEvent.setup()
  layout(600, 200)
  openedUrls.length = 0
  const rule = {
    prefix: "JIRA-",
    url: "https://jira.example.com/browse/JIRA-<num>",
    alphanumeric: false,
    ignoreCase: false,
    title: "Issue <num>"
  }
  render(
    <RichText
      emoji={new Map()}
      text="Fixes JIRA-123 :tada: see https://example.com/notes and !12"
      autolinks={autolinkRefSets(
        [rule],
        { host: "gitlab.example", owner: "group/subgroup", name: "project" },
        "gitlab",
        (key, options) => i18n.t(key, options ?? {})
      )}
    />
  )
  await user.click(screen.getByRole("link", { name: "JIRA-123" }))
  await waitFor(() => expect(openedUrls).toEqual(["https://jira.example.com/browse/JIRA-123"]))
  expect(screen.getByRole("link", { name: "!12" })).toHaveAttribute(
    "href",
    "https://gitlab.example/group/subgroup/project/-/merge_requests/12"
  )
})

// ---- Settings/Accounts ----
test("preferences: accounts follow Desktop's sections, signed-in rows and sign-in calls to action (Accounts)", async () => {
  fixtures({ oauth_default_clients: () => ({ "github.com": "builtin-client" }) })
  render(
    <Preferences
      open
      initialTab="accounts"
      onOpenChange={() => {}}
      onPatch={() => {}}
      onAccountsChanged={() => {}}
      hosts={["git.example.com", "github.com", "gitlab.com"]}
      accounts={{
        "github.com": {
          kind: "github",
          login: "octocat",
          name: "The Octocat",
          owners: [],
          source: "settings",
          ignored: false
        }
      }}
      state={preferencesState as never}
    />
  )
  const section = (name: string) => screen.getByRole("group", { name })
  // GitHub.com：已登录照 Desktop renderAccount —— 名字、@login、退出
  const dotCom = section("GitHub.com")
  expect(within(dotCom).getByText("The Octocat")).toBeVisible()
  expect(within(dotCom).getByText("@octocat")).toBeVisible()
  expect(within(dotCom).getByRole("button", { name: t("prefs.signOut") })).toBeVisible()
  // GitLab.com：未登录照 Desktop CallToAction —— 说明在上，没有内置应用 ID 时给令牌输入
  const gitlab = section("GitLab.com")
  expect(within(gitlab).getByText(t("prefs.signInToAccessRepositories", { host: "GitLab.com" }))).toBeVisible()
  expect(within(gitlab).getByLabelText(t("prefs.pasteToken"))).toBeVisible()
  // 自建实例单独一节，按实例地址列出，最后是添加实例
  const instances = section(t("prefs.githubEnterpriseAndGitLabSelfManaged"))
  expect(within(instances).getByText("git.example.com")).toBeVisible()
  expect(within(instances).queryByText(t("prefs.useAnInstanceAtWork"))).not.toBeInTheDocument()
  expect(within(instances).getByRole("button", { name: t("prefs.addInstance") })).toBeDisabled()
  expect(screen.queryByRole("group", { name: "git.example.com" })).not.toBeInTheDocument()
})
test("preferences: a built-in OAuth app shows Desktop's Sign Into button for a signed-out GitHub.com (SignIntoGitHub)", async () => {
  fixtures({ oauth_default_clients: () => ({ "github.com": "builtin-client" }) })
  render(
    <Preferences
      open
      initialTab="accounts"
      onOpenChange={() => {}}
      onPatch={() => {}}
      onAccountsChanged={() => {}}
      hosts={["github.com", "gitlab.com"]}
      accounts={{}}
      state={preferencesState as never}
    />
  )
  const dotCom = screen.getByRole("group", { name: "GitHub.com" })
  expect(
    await within(dotCom).findByRole("button", { name: t("prefs.signIntoHost", { host: "GitHub.com" }) })
  ).toBeVisible()
  expect(within(dotCom).getByText(t("prefs.signInToAccessRepositories", { host: "GitHub.com" }))).toBeVisible()
  // 没有自建实例时照 Desktop Enterprise 的空状态给一句说明
  expect(screen.getByText(t("prefs.useAnInstanceAtWork"))).toBeVisible()
})

// ---- Settings：触控板开关随「保存」提交 ----
function trackpadPreferences(available: boolean, enabled: boolean) {
  fixtures({ has_trackpad: () => available })
  const onPatch = mock()
  const onOpenChange = mock()
  render(
    <Preferences
      open
      initialTab="trackpad"
      onOpenChange={onOpenChange}
      onPatch={onPatch}
      onAccountsChanged={() => {}}
      hosts={["github.com"]}
      accounts={{}}
      state={{ ...preferencesState, canvasTrackpadGestures: enabled } as never}
    />
  )
  return { onPatch, toggle: () => screen.getByRole("switch", { name: t("prefs.canvasTrackpad") }) }
}
test("preferences: the trackpad switch is written on Save, not on toggle (Trackpad)", async () => {
  const user = userEvent.setup()
  const { onPatch, toggle } = trackpadPreferences(true, false)
  await waitFor(() => expect(toggle()).not.toHaveAttribute("aria-disabled", "true"))
  expect(toggle()).not.toBeChecked()
  await user.click(toggle())
  expect(onPatch).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: t("common.save") }))
  await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ canvasTrackpadGestures: true }))
})
test("preferences: without a trackpad the switch is disabled and off and saving changes nothing (TrackpadUnavailable)", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  const { onPatch, toggle } = trackpadPreferences(false, true)
  expect(await screen.findByText(t("prefs.noTrackpad"))).toBeVisible()
  expect(toggle()).toHaveAttribute("aria-disabled", "true")
  expect(toggle()).not.toBeChecked()
  await user.click(toggle())
  await user.click(screen.getByRole("button", { name: t("common.save") }))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(onPatch).not.toHaveBeenCalled()
})

test("preferences: a trackpad connected or disconnected while Settings is open updates the switch on window focus (TrackpadReconnect)", async () => {
  let present = false
  fixtures({
    has_trackpad: () => {
      const result = present
      present = !present
      return result
    }
  })
  render(
    <Preferences
      open
      initialTab="trackpad"
      onOpenChange={() => {}}
      onPatch={() => {}}
      onAccountsChanged={() => {}}
      hosts={["github.com"]}
      accounts={{}}
      state={{ ...preferencesState, canvasTrackpadGestures: true } as never}
    />
  )
  const toggle = () => screen.getByRole("switch", { name: t("prefs.canvasTrackpad") })
  expect(await screen.findByText(t("prefs.noTrackpad"))).toBeVisible()
  expect(toggle()).toHaveAttribute("aria-disabled", "true")
  window.dispatchEvent(new Event("focus"))
  await waitFor(() => expect(toggle()).not.toHaveAttribute("aria-disabled", "true"))
  expect(toggle()).toBeChecked()
  window.dispatchEvent(new Event("focus"))
  await waitFor(() => expect(toggle()).toHaveAttribute("aria-disabled", "true"))
  expect(toggle()).not.toBeChecked()
})

// ---- Lists/Controlled virtual grid ----
test("virtual grid: controlled scrollTop, imperative scroll, recompute and ref release on unmount (ControlledOffsetsAndImperativeRef)", async () => {
  const user = userEvent.setup()
  const refs: (GridImperativeAPI | null)[] = []
  function ControlledGrid() {
    const ref = useRef<GridImperativeAPI | null>(null)
    const [offset, setOffset] = useState<number | undefined>(200)
    const [mounted, setMounted] = useState(true)
    return (
      <div>
        <button onClick={() => setOffset(600)}>Set offset</button>
        <button onClick={() => setOffset(undefined)}>Release control</button>
        <button onClick={() => ref.current?.scrollToPosition({ scrollTop: 400 })}>Scroll imperatively</button>
        <button onClick={() => ref.current?.recomputeGridSize()}>Recompute</button>
        <button onClick={() => setMounted(false)}>Unmount</button>
        {mounted && (
          <Grid
            ref={value => {
              ref.current = value
              refs.push(value)
            }}
            scrollTop={offset}
            width={300}
            height={100}
            columnCount={1}
            columnWidth={300}
            rowCount={100}
            rowHeight={20}
            cellRenderer={({ key, style, rowIndex }) => (
              <div key={key} style={style}>
                Row {rowIndex}
              </div>
            )}
          />
        )}
      </div>
    )
  }
  const { container } = render(<ControlledGrid />)
  const viewport = container.querySelector<HTMLElement>(".ReactVirtualized__Grid")!
  expect(viewport).not.toBeNull()
  await waitFor(() => expect(viewport.scrollTop).toBe(200))
  await user.click(screen.getByRole("button", { name: "Set offset" }))
  await waitFor(() => expect(viewport.scrollTop).toBe(600))
  await user.click(screen.getByRole("button", { name: "Release control" }))
  await user.click(screen.getByRole("button", { name: "Scroll imperatively" }))
  await waitFor(() => expect(viewport.scrollTop).toBe(400))
  await user.click(screen.getByRole("button", { name: "Recompute" }))
  expect(viewport.scrollTop).toBe(400)
  await user.click(screen.getByRole("button", { name: "Unmount" }))
  expect(refs.at(-1)).toBeNull()
  expect(viewport).not.toBeInTheDocument()
})
