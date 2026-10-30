import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, fn, userEvent, waitFor } from "storybook/test"

import { assertNativeFixtures, nativeCall, withNativeFixtures } from "../.storybook/mocks/native"
import { mockTrendingBrowser, mockTrendingWebview } from "../.storybook/mocks/trending"
import i18n from "../src/lib/i18n"
import type { Route } from "../src/lib/navigate"
import type { RemoteRepo } from "../src/models/app-state"
import { FloatingWorkspace } from "../src/ui/layout/floating-workspace"
import { RepositoryRail } from "../src/ui/repository/repository-rail"
import { Discover } from "../src/ui/trending/discover"

const projects: RemoteRepo[] = [
  {
    owner: "cloudflare",
    name: "security-audit-skill",
    description:
      "A coding-agent skill for multi-phase security audits with independent verification and machine-readable findings.",
    language: "TypeScript",
    stars: 37334,
    host: "github.com",
    private: false,
    fork: false,
    url: "https://github.com/cloudflare/security-audit-skill"
  },
  {
    owner: "vllm-project",
    name: "vllm",
    description: "A high-throughput and memory-efficient inference and serving engine for LLMs.",
    language: "Python",
    stars: 95003,
    host: "github.com",
    private: false,
    fork: false,
    url: "https://github.com/vllm-project/vllm"
  },
  {
    owner: "supabase",
    name: "supabase",
    description: "The Postgres development platform. Build reliable applications with a full PostgreSQL database.",
    language: "TypeScript",
    stars: 113157,
    host: "github.com",
    private: false,
    fork: false,
    url: "https://github.com/supabase/supabase"
  },
  {
    owner: "example-organization-with-a-long-name",
    name: "repository-with-a-long-name",
    description:
      "A longer repository description to verify truncation without pushing clone actions outside the window or wrapping the toolbar.",
    language: "Rust",
    stars: 12513,
    host: "github.com",
    private: false,
    fork: false,
    url: "https://github.com/example-organization-with-a-long-name/repository-with-a-long-name"
  }
]
const repositories = [
  "gitcub",
  "skills",
  "mcp-chrome",
  "agency-agents",
  "supabase",
  "vllm",
  "vscode-gitlens",
  "opencode",
  "financial-services"
].map(name => `/preview/${name}`)
const hosts = ["github.com"]
const cloned = new Map<string, string>()
const remoteProjects = projects.map(repo => ({ ...repo, host: "github.com", private: false }))

function DiscoveryWindow({ longLists = false }: { longLists?: boolean }) {
  const [route, setRoute] = useState<Route>({ kind: "mine" })
  const [page, setPage] = useState(1)
  const navigate = (uri: string) => {
    const kind = new URL(uri).host
    if (kind === "discover") {
      setPage(0)
      return
    }
    if (kind === "mine" || kind === "stars") {
      setRoute({ kind })
      setPage(1)
    }
  }
  return (
    <div className="flex h-[680px] min-w-0 overflow-hidden">
      <FloatingWorkspace
        page={page}
        onPageChange={setPage}
        navigation={
          <RepositoryRail
            repositories={
              longLists ? Array.from({ length: 40 }, (_, index) => `/preview/repository-${index + 1}`) : repositories
            }
            route={route}
            trendingActive={page === 0}
            onNavigate={navigate}
            remotes={{}}
            accounts={{}}
            current={null}
            onAdd={fn()}
            onNewRepo={fn()}
            author={{ name: "NY", email: "" }}
            ownership={
              longLists
                ? Object.fromEntries(
                    Array.from({ length: 40 }, (_, index) => [`/preview/repository-${index + 1}`, "mine" as const])
                  )
                : { "/preview/gitcub": "mine" }
            }
            onOwnershipChange={fn()}
            onSyncUpstream={fn()}
          />
        }>
        <main className="min-w-0 flex-1">
          <Discover route={route} onNavigate={navigate} hosts={hosts} cloned={cloned} onOpen={fn()} onCloned={fn()} />
        </main>
      </FloatingWorkspace>
    </div>
  )
}

const meta = {
  title: "Discovery/Window",
  component: DiscoveryWindow,
  tags: ["desktop-window"],
  parameters: { layout: "fullscreen" },
  beforeEach: withNativeFixtures({
    sync_trending_webview: mockTrendingWebview,
    control_trending_webview: mockTrendingBrowser,
    my_repos: () => remoteProjects,
    my_stars: () => remoteProjects
  }),
  afterEach: assertNativeFixtures
} satisfies Meta<typeof DiscoveryWindow>
export default meta
type Story = StoryObj<typeof meta>

export const Overview: Story = {}
export const FiltersAndNavigation: Story = {
  play: async ({ canvas }) => {
    await canvas.findByRole("link", { name: "cloudflare/security-audit-skill" })
    await userEvent.click(canvas.getByRole("tab", { name: i18n.t("discover.mine") }))
    await canvas.findByRole("link", { name: "cloudflare/security-audit-skill" })
    await expect(canvas.getByRole("tab", { name: i18n.t("discover.mine") })).toHaveAttribute("aria-selected", "true")
    await userEvent.click(canvas.getByRole("tab", { name: i18n.t("discover.stars") }))
    await waitFor(() =>
      expect(nativeCall).toHaveBeenCalledWith("my_stars", expect.objectContaining({ host: "github.com" }))
    )
    await userEvent.click(canvas.getByRole("tab", { name: i18n.t("rail.mine") }))
    await expect(canvas.getByRole("tabpanel", { name: i18n.t("rail.mine") })).toBeVisible()
    await expect(canvas.getByRole("button", { name: "gitcub" })).toBeVisible()
    await userEvent.keyboard("{ArrowRight}")
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(canvas.getByRole("tab", { name: i18n.t("rail.thirdParty") })).toHaveAttribute("aria-selected", "true")
    )
    await expect(canvas.getByRole("tabpanel", { name: i18n.t("rail.thirdParty") })).toBeVisible()
    await userEvent.type(canvas.getByPlaceholderText(i18n.t("rail.searchRepositories")), "vllm")
    await expect(canvas.getByRole("button", { name: "vllm" })).toBeVisible()
    await expect(canvas.queryByRole("button", { name: "gitcub" })).not.toBeInTheDocument()
  }
}

export const LongLists: Story = {
  args: { longLists: true },
  beforeEach: withNativeFixtures({
    sync_trending_webview: mockTrendingWebview,
    control_trending_webview: mockTrendingBrowser,
    my_repos: () =>
      Array.from({ length: 40 }, (_, index) => ({
        ...projects[index % projects.length],
        owner: "example",
        name: `repository-${index + 1}`,
        url: `https://github.com/example/repository-${index + 1}`
      }))
  })
}
