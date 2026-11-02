import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
import { getDesktopRuntime } from "../src/lib/desktop-runtime"
import { RepositorySettings } from "../src/ui/repository-settings/repository-settings"

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
  beforeEach: withNativeFixtures(fixtures),
  args: { repo: "/preview/repository", primaryRemote: "origin", hosted, onDismissed: fn(), onPublish: fn() }
} satisfies Meta<typeof RepositorySettings>
export default meta
type Story = StoryObj<typeof meta>

/** Desktop RepositorySettings */
export const Default: Story = {}

/** Desktop NoRemote：没有远端时引导发布 */
export const NoRemote: Story = {
  beforeEach: withNativeFixtures({ ...fixtures, remotes: () => [] })
}

/** Desktop ForkSettings：fork 默认为上游贡献；改成「自己使用」后说明跟着草稿变，保存才写进仓库库 */
export const Fork: Story = {
  beforeEach: withRegisteredFork
}
