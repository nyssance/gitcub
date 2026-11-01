import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import { getDesktopRuntime } from "../src/lib/desktop-runtime"
import { readForkContributionTarget } from "../src/lib/fork-contribution"
import i18n from "../src/lib/i18n"
import { RepositorySettings } from "../src/ui/repository-settings/repository-settings"
import { ForkContributionTarget } from "../src/upstream/models/workflow-preferences"

const ok = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  path: "/preview/repository",
  gitError: null,
  gitErrorDescription: null
}
const fixtures = {
  remotes: () => [
    ["origin", "https://github.com/gitcub/gitcub.git"],
    ["upstream", "https://github.com/desktop/desktop.git"]
  ],
  read_gitignore: () => "node_modules\n",
  get_config_value: () => null,
  global_config_value: (args: unknown) =>
    (args as { key: string }).key === "user.name" ? "Global Name" : "global@example.test",
  git_execute: () => ok,
  // 不是 fork：上游就是自己
  pull_request_repository: (args: unknown) => args
}
const hosted = { host: "github.com", owner: "gitcub", name: "gitcub" }
const parent = { host: "github.com", owner: "desktop", name: "desktop" }

// Desktop 仓库库（命名 JSON 存储）的内存替身：fork 行为存在里面
const stores = new Map<string, Record<string, unknown>>()
const storeFixtures = {
  store_entries: (args: unknown) => {
    const { scope, store } = args as { scope: string; store: string }
    return { ...stores.get(`${scope}/${store}`) }
  },
  store_set: (args: unknown) => {
    const { scope, store, key, value } = args as { scope: string; store: string; key: string; value: unknown }
    stores.set(`${scope}/${store}`, { ...stores.get(`${scope}/${store}`), [key]: value })
  }
}
const forkFixtures = {
  ...fixtures,
  ...storeFixtures,
  pull_request_repository: () => parent
}
const withRegisteredFork = () => {
  stores.clear()
  const cleanup = withNativeFixtures(forkFixtures)()
  return getDesktopRuntime()
    .repositoriesStore.addRepository("/preview/repository", undefined)
    .then(() => cleanup)
}

const meta = {
  title: "Settings/Repository settings",
  component: RepositorySettings,
  parameters: { layout: "fullscreen" },
  tags: ["desktop-window"],
  beforeEach: withNativeFixtures(fixtures),
  afterEach: assertNativeFixtures,
  args: { repo: "/preview/repository", primaryRemote: "origin", hosted, onDismissed: fn(), onPublish: fn() }
} satisfies Meta<typeof RepositorySettings>
export default meta
type Story = StoryObj<typeof meta>

const writes = () =>
  nativeCall.mock.calls.filter(
    ([command, args]) =>
      ["set_remote_url", "write_gitignore"].includes(command) ||
      (command === "git_execute" && (args as { args: string[] }).args[0] === "config")
  )

/** Desktop RepositorySettings：各页签只改草稿，点「保存」按远端 → .gitignore → 本地身份写入后关闭 */
export const SaveWritesDrafts: Story = {
  play: async ({ args }) => {
    const screen = within(document.body)
    const url = await screen.findByLabelText(
      i18n.t("repositorySettings.primaryRemoteRepositoryUrl", { name: "origin" })
    )
    await waitFor(() => expect(url).toHaveValue("https://github.com/gitcub/gitcub.git"))
    await userEvent.clear(url)
    await userEvent.type(url, "https://github.com/gitcub/renamed.git ")
    await userEvent.click(screen.getByRole("tab", { name: i18n.t("repositorySettings.ignoredFiles") }))
    const ignore = screen.getByRole("textbox", { name: i18n.t("repositorySettings.ignoredFiles") })
    await userEvent.type(ignore, "target\n")
    await userEvent.click(screen.getByRole("tab", { name: i18n.t("repositorySettings.gitConfig") }))
    const name = screen.getByLabelText(i18n.t("prefs.name"))
    await expect(name).toBeDisabled()
    await expect(name).toHaveValue("Global Name")
    await userEvent.click(screen.getByRole("radio", { name: i18n.t("repositorySettings.useALocalGitConfig") }))
    await userEvent.clear(name)
    await userEvent.type(name, "Local Name")
    await expect(writes()).toEqual([])
    await userEvent.click(screen.getByRole("button", { name: i18n.t("common.save") }))
    await waitFor(() => expect(args.onDismissed).toHaveBeenCalled())
    await expect(nativeCall).toHaveBeenCalledWith("set_remote_url", {
      repo: "/preview/repository",
      name: "origin",
      url: "https://github.com/gitcub/renamed.git"
    })
    await expect(nativeCall).toHaveBeenCalledWith("write_gitignore", {
      repo: "/preview/repository",
      content: "node_modules\ntarget\n"
    })
    const configs = writes()
      .filter(([command]) => command === "git_execute")
      .map(([, args]) => (args as { args: string[] }).args)
    await expect(configs).toEqual([
      ["config", "--replace-all", "user.name", "Local Name"],
      ["config", "--replace-all", "user.email", "global@example.test"]
    ])
  }
}

export const CancelWritesNothing: Story = {
  play: async ({ args }) => {
    const screen = within(document.body)
    await userEvent.click(await screen.findByRole("tab", { name: i18n.t("repositorySettings.ignoredFiles") }))
    const ignore = screen.getByRole("textbox", { name: i18n.t("repositorySettings.ignoredFiles") })
    await waitFor(() => expect(ignore).toBeEnabled())
    await userEvent.type(ignore, "dist\n")
    await userEvent.click(screen.getByRole("button", { name: i18n.t("common.cancel") }))
    await expect(args.onDismissed).toHaveBeenCalled()
    await expect(writes()).toEqual([])
  }
}

/** 读 .gitignore 失败：报错、文本框不可编辑，保存不会写空文件覆盖它 */
export const FailedIgnoreReadCannotWrite: Story = {
  beforeEach: withNativeFixtures({
    ...fixtures,
    read_gitignore: () => {
      throw new Error("Cannot read ignore file")
    }
  }),
  play: async () => {
    const screen = within(document.body)
    await expect(await screen.findByText(/Cannot read ignore file/)).toBeVisible()
    await userEvent.click(screen.getByRole("tab", { name: i18n.t("repositorySettings.ignoredFiles") }))
    await expect(screen.getByRole("textbox", { name: i18n.t("repositorySettings.ignoredFiles") })).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: i18n.t("common.save") }))
    await expect(nativeCall.mock.calls.some(([command]) => command === "write_gitignore")).toBe(false)
  }
}

/** 本项目独有的其他远端增删立即生效，不丢掉 .gitignore 里还没保存的草稿 */
export const RemoveOtherRemoteKeepsDrafts: Story = {
  beforeEach: () => {
    let removed = false
    return withNativeFixtures({
      ...fixtures,
      remotes: () => (removed ? [fixtures.remotes()[0]] : fixtures.remotes()),
      remove_remote: () => {
        removed = true
      }
    })()
  },
  play: async () => {
    const screen = within(document.body)
    await userEvent.click(await screen.findByRole("tab", { name: i18n.t("repositorySettings.ignoredFiles") }))
    const ignore = screen.getByRole("textbox", { name: i18n.t("repositorySettings.ignoredFiles") })
    await waitFor(() => expect(ignore).toBeEnabled())
    await userEvent.type(ignore, "custom-output\n")
    await userEvent.click(screen.getByRole("tab", { name: i18n.t("repositorySettings.remote") }))
    await userEvent.click(screen.getByRole("button", { name: i18n.t("prefs.removeRemote") }))
    await waitFor(() => expect(screen.queryByText("upstream")).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole("tab", { name: i18n.t("repositorySettings.ignoredFiles") }))
    await expect(screen.getByRole("textbox", { name: i18n.t("repositorySettings.ignoredFiles") })).toHaveValue(
      "node_modules\ncustom-output\n"
    )
  }
}

/** Desktop NoRemote：没有远端时引导发布 */
export const NoRemote: Story = {
  beforeEach: withNativeFixtures({ ...fixtures, remotes: () => [] }),
  play: async ({ args }) => {
    const screen = within(document.body)
    await userEvent.click(await screen.findByRole("button", { name: "Publish" }))
    await expect(args.onPublish).toHaveBeenCalled()
  }
}

/** 不是 fork 就没有 Fork Behavior 页签 */
export const NotAForkHasNoForkBehavior: Story = {
  play: async () => {
    const screen = within(document.body)
    await screen.findByRole("tab", { name: i18n.t("repositorySettings.gitConfig") })
    await waitFor(() => expect(nativeCall).toHaveBeenCalledWith("pull_request_repository", hosted))
    await expect(screen.queryByRole("tab", { name: i18n.t("repositorySettings.forkBehavior") })).not.toBeInTheDocument()
  }
}

/** Desktop ForkSettings：fork 默认为上游贡献；改成「自己使用」后说明跟着草稿变，保存才写进仓库库 */
export const ForkBehaviorSaves: Story = {
  beforeEach: withRegisteredFork,
  play: async ({ args }) => {
    const screen = within(document.body)
    await userEvent.click(await screen.findByRole("tab", { name: i18n.t("repositorySettings.forkBehavior") }))
    const parentOption = screen.getByRole("radio", {
      name: i18n.t("repositorySettings.toContributeToTheParentRepository")
    })
    await waitFor(() => expect(parentOption).toBeChecked())
    await expect(screen.getAllByText("desktop/desktop")).toHaveLength(5)
    await userEvent.click(screen.getByRole("radio", { name: i18n.t("repositorySettings.forMyOwnPurposes") }))
    await expect(screen.getAllByText("gitcub/gitcub")).toHaveLength(5)
    await expect(await readForkContributionTarget("/preview/repository")).toBe(ForkContributionTarget.Parent)
    await userEvent.click(screen.getByRole("button", { name: i18n.t("common.save") }))
    await waitFor(() => expect(args.onDismissed).toHaveBeenCalled())
    await expect(await readForkContributionTarget("/preview/repository")).toBe(ForkContributionTarget.Self)
  }
}
