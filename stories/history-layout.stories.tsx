import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { fn } from "storybook/test"

import { assertNativeFixtures, withNativeFixtures } from "../.storybook/mocks/native"
import type { CommitFile } from "../src/models/history"
import { DiffView } from "../src/ui/diff/diff"
import { CommitDetails } from "../src/ui/history/commit-details"
import { HistorySidebar } from "../src/ui/history/sidebar"
import { RepositorySplit } from "../src/ui/repository/repository-split"
import { DiffParser } from "../src/upstream/lib/diff-parser"
import { commit, repo } from "./fixtures"

const paths = [
  "law-student/CLAUDE.md",
  "law-student/skills/bar-prep-questions/SKILL.md",
  "law-student/skills/case-brief/SKILL.md",
  "managed-agent-cookbooks/reg-monitor/src/an-extremely-long-file-name-without-spaces.ts"
]
const files: CommitFile[] = paths.map((path, i) => ({
  path,
  kind: "modified",
  oldPath: null,
  renameIncludesModifications: false,
  submodule: false,
  linesAdded: i === 0 ? 12 : 3,
  linesDeleted: i === 0 ? 4 : 0
}))
const commits = Array.from({ length: 15 }, (_, i) => ({
  ...commit,
  sha: String(i).padStart(40, "0"),
  shortSha: String(i).padStart(7, "0"),
  summary: i === 0 ? "Update plugin content (#104)" : "Merge pull request with a very long title to verify truncation",
  authorName: i % 2 ? "Matt Piccolella" : "Mark Pike"
}))
const diff = new DiffParser().parse(
  "diff --git a/CLAUDE.md b/CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1 @@\n-Previous content\n+Updated content\n"
)
const action = fn()
function HistoryWindow() {
  const [selected, setSelected] = useState(paths[0])
  return (
    <div className="flex h-[650px] min-w-0 ps-60" data-history-window>
      <RepositorySplit
        initialWidth={600}
        sidebar={
          <div className="flex h-full min-h-0 flex-col">
            <HistorySidebar
              commits={commits}
              repo={repo}
              rows={commits.map((entry, i) => ({
                commit: entry,
                lane: 0,
                lanes: [entry.sha],
                // the two newest commits are ahead of origin (pushStatus ahead: 2), so the remote refs sit on the third
                refs: i === 0 ? ["main"] : i === 2 ? ["origin/HEAD", "origin/main"] : []
              }))}
              selected={commits[0].sha}
              pushStatus={{ remote: "origin", hasUpstream: true, ahead: 2 }}
              onSelect={action}
              onRevert={action}
              onCherryPick={action}
              onCherryPickMany={action}
              onSquashMany={action}
              currentBranch="main"
              onMerge={action}
              onCreateTag={action}
              onResetTo={action}
              onSquashIntoParent={action}
              onMove={action}
              onReorder={action}
            />
          </div>
        }>
        <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          <CommitDetails
            commit={commits[0]}
            remote={{ host: "github.com", owner: "nyssance", name: "atlas" }}
            files={files}
            selected={selected}
            onSelect={setSelected}>
            <DiffView
              file={selected}
              diff={diff}
              selection={null}
              error={null}
              repo={repo}
              sha={commits[0].sha}
              readOnly
            />
          </CommitDetails>
        </div>
      </RepositorySplit>
    </div>
  )
}
const meta = {
  title: "History/Window",
  component: HistoryWindow,
  tags: ["desktop-window"],
  beforeEach: () => {
    localStorage.setItem("diff-layout", "unified")
    return withNativeFixtures({ branches: () => [], "plugin:opener|open_url": () => undefined })()
  },
  afterEach: assertNativeFixtures
} satisfies Meta<typeof HistoryWindow>
export default meta
type Story = StoryObj<typeof meta>
export const LongPaths: Story = {}
