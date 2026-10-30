import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
import { routes } from "../src/lib/navigate"
import { RepositoryRail } from "../src/ui/repository/repository-rail"

const meta = {
  title: "Repositories/Navigation",
  component: RepositoryRail,
  decorators: [
    Story => (
      <div className="h-[620px] w-60">
        <Story />
      </div>
    )
  ],
  beforeEach: withNativeFixtures({}),
  afterEach: assertNativeFixtures,
  args: {
    repositories: [
      "/preview/gitcub",
      "/preview/atlas",
      "/preview/very-long-repository-name-for-truncation",
      "/preview/team"
    ],
    current: "/preview/gitcub",
    route: { kind: "repo" },
    remotes: {
      "/preview/gitcub": { host: "github.com", owner: "nyssance", name: "gitcub" },
      "/preview/atlas": { host: "github.com", owner: "nyssance", name: "atlas" },
      "/preview/team": { host: "gitlab.example", owner: "team/subgroup", name: "team" }
    },
    accounts: {
      "github.com": { kind: "github", login: "nyssance", owners: ["nyssance"], source: "settings", ignored: false },
      "gitlab.example": { kind: "gitlab", login: "ny", owners: ["team"], source: "settings", ignored: false }
    },
    author: { name: "NY", email: "" },
    ownership: {},
    onNavigate: fn(),
    onAdd: fn(),
    onNewRepo: fn(),
    onOwnershipChange: fn(),
    onSyncUpstream: fn()
  }
} satisfies Meta<typeof RepositoryRail>
export default meta
type Story = StoryObj<typeof meta>

export const Grouped: Story = {}
const longRepositories = Array.from({ length: 30 }, (_, index) => `/preview/repository-with-a-very-long-name-${index}`)
export const LongGroups: Story = {
  args: {
    repositories: [...longRepositories, "/preview/team"],
    remotes: {
      ...Object.fromEntries(
        longRepositories.map(path => [path, { host: "github.com", owner: "nyssance", name: path.split("/").at(-1)! }])
      ),
      "/preview/team": { host: "gitlab.example", owner: "team/subgroup", name: "team" }
    }
  }
}
export const CachedOwnershipSurvivesReadFailure: Story = {
  args: { remoteErrors: { "/preview/gitcub": "Unable to read origin" } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "gitcub" })).toBeVisible()
    await expect(canvas.queryByText(i18n.t("rail.emptyMine"))).not.toBeInTheDocument()
    await expect(canvas.queryByText(i18n.t("rail.signedOutTitle"))).not.toBeInTheDocument()
    await expect(nativeCall).not.toHaveBeenCalled()
  }
}
export const EmptyMineStaysSelected: Story = {
  args: { accounts: {}, remotes: {} },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("tab", { name: i18n.t("rail.mine") })).toHaveAttribute("aria-selected", "true")
    await expect(canvas.queryByRole("button", { name: "gitcub" })).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("tab", { name: i18n.t("rail.thirdParty") }))
    await expect(canvas.getByRole("button", { name: "gitcub" })).toBeVisible()
  }
}
export const NavigationAndGroups: Story = {
  play: async ({ canvas, args }) => {
    await expect(nativeCall).not.toHaveBeenCalled()
    await expect(canvas.getByRole("button", { name: "gitcub" }).querySelector("svg")).toBeNull()
    const group = canvas.getByRole("button", { name: "GitHub 2" })
    await userEvent.click(group)
    await expect(canvas.queryByRole("button", { name: "gitcub" })).not.toBeInTheDocument()
    await userEvent.click(group)
    await userEvent.click(canvas.getByRole("button", { name: "atlas" }))
    await expect(args.onNavigate).toHaveBeenCalledWith(routes.repo("/preview/atlas"))
    await userEvent.click(canvas.getByRole("tab", { name: i18n.t("rail.thirdParty") }))
    await expect(canvas.getByRole("button", { name: "very-long-repository-name-for-truncation" })).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "NY" }))
    await userEvent.keyboard("{Escape}")
  }
}
