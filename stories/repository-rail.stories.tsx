import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
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
