import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"

import { diffLineMapping, projectDiffSelection, restoreDiffSelection } from "../../src/lib/diff-selection-mapping"
import { ipc } from "../../src/lib/ipc"
import { cherryPickToPullRequest, findPullRequestBranch } from "../../src/lib/pull-request-checkout"
import { pullRequestCreationURL, type PullRequestTargets } from "../../src/lib/pull-request-navigation"
import { getDiffRows } from "../../src/ui/diff/desktop-diff-rows"
import { DiffParser } from "../../src/upstream/lib/diff-parser"
import { DiffType } from "../../src/upstream/models/diff"
import { DiffSelection, DiffSelectionType } from "../../src/upstream/models/diff/diff-selection"

const context: PullRequestTargets = {
  kind: "github",
  sourceId: 12,
  remote: { host: "enterprise.example:8443", owner: "contributor", name: "fork" },
  targets: [{ fullName: "upstream/project", id: 32, defaultBranch: "develop", branches: ["develop"] }]
}
it("GitHub creation uses the target repository, source owner, actual base and Enterprise port", () => {
  const url = new URL(pullRequestCreationURL(context, 0, "feature/中文", "release/next"))
  assert.equal(url.host, "enterprise.example:8443")
  assert.equal(decodeURIComponent(url.pathname), "/upstream/project/compare/release/next...contributor:feature/中文")
  assert.equal(url.searchParams.get("expand"), "1")
})
it("GitLab creation preserves fork project IDs, subgroup paths and literal branch names", () => {
  const url = new URL(
    pullRequestCreationURL(
      { ...context, kind: "gitlab", targets: [{ ...context.targets[0], fullName: "group/sub/project" }] },
      0,
      "feature/a&b",
      "trunk"
    )
  )
  assert.equal(url.pathname, "/group/sub/project/-/merge_requests/new")
  assert.equal(url.searchParams.get("merge_request[source_project_id]"), "12")
  assert.equal(url.searchParams.get("merge_request[target_project_id]"), "32")
  assert.equal(url.searchParams.get("merge_request[source_branch]"), "feature/a&b")
  assert.equal(url.searchParams.get("merge_request[target_branch]"), "trunk")
  assert.throws(() => pullRequestCreationURL(context, 2, "a", "b"))
})
it("whitespace-filtered selection changes only the corresponding canonical patch lines", () => {
  const full = new DiffParser().parse(
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n-white space\n+white  space\n same\n-old\n+new\n"
  )
  const display = new DiffParser().parse("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2,2 +2,2 @@\n same\n-old\n+new\n")
  const mapping = diffLineMapping(full, display)
  const selected = DiffSelection.fromInitialSelection(DiffSelectionType.All)
    .withSelectableLines(new Set([1, 2, 4, 5]))
    .withLineSelection(1, false)
  const projected = projectDiffSelection(selected, mapping, new Set([2, 3]))
  assert.equal(projected.isSelected(2), true)
  const next = restoreDiffSelection(selected, projected.withLineSelection(2, false), mapping)
  assert.equal(next.isSelected(1), false, "hidden whitespace selection remains untouched")
  assert.equal(next.isSelected(2), true, "hidden whitespace addition remains selected")
  assert.equal(next.isSelected(4), false, "visible deletion maps to canonical line 4")
  assert.equal(next.isSelected(5), true)
})
it("Desktop split rows pair added/deleted lines without losing original patch positions", () => {
  const diff = new DiffParser().parse(
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n same\n"
  )
  const rows = getDiffRows({ ...diff, kind: DiffType.Text, text: diff.contents }, true, false)
  assert.deepEqual(
    rows.map(row => row.type),
    ["Hunk", "Modified", "Added", "Context"]
  )
  const modified = rows[1]
  assert.equal(modified.type, "Modified")
  if (modified.type === "Modified") {
    assert.equal(modified.beforeData.diffLineNumber, 1)
    assert.equal(modified.afterData.diffLineNumber, 2)
  }
})

for (const kind of ["github", "gitlab"] as const) {
  it(`${kind} fork checkout uses a tracked request branch and preserves conflicting local branches`, async t => {
    const root = mkdtempSync(join(tmpdir(), "gitcub-request-checkout-"))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const git = (repo: string, ...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
    const repo = join(root, "repo")
    const fork = join(root, "fork")
    execFileSync("git", ["init", "-q", "-b", "main", repo])
    git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base")
    const base = git(repo, "rev-parse", "HEAD")
    execFileSync("git", ["clone", "-q", repo, fork])
    writeFileSync(join(fork, "fork.txt"), "from fork\n")
    git(fork, "add", ".")
    git(fork, "-c", "commit.gpgsign=false", "commit", "-m", "fork change")
    const source = {
      number: 17,
      owner: kind === "github" ? "alice" : "group/sub",
      cloneUrl: `https://${kind}.example/${kind === "github" ? "alice" : "group/sub"}/fork.git`,
      branch: "main",
      target: { host: `${kind}.example`, owner: "upstream", name: "project" }
    }
    const prefix = kind === "github" ? "pr" : "mr"
    git(repo, "remote", "add", "origin", `https://${kind}.example/upstream/project.git`)
    let fetches = 0
    // The network transport is an isolated local fork; branch/ref operations are production Rust IPC.
    const adapter = {
      ...ipc,
      fetch: async (path: string, remote: string) => {
        fetches++
        await ipc.fetchRefspec(path, fork, `+refs/heads/main:refs/remotes/${remote}/main`)
      }
    }
    const name = await findPullRequestBranch(repo, source, adapter, prefix)
    assert.equal(name, `${prefix}/17`)
    await ipc.checkout(repo, name)
    assert.equal(git(repo, "rev-parse", "HEAD"), git(fork, "rev-parse", "HEAD"))
    assert.equal(git(repo, "rev-parse", "main"), base)
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), `github-desktop-${source.owner}/main`)
    const remoteBranch = (await ipc.branchDetails(repo)).find(
      b => b.remote && b.name === `github-desktop-${source.owner}/main`
    )!
    assert.equal(remoteBranch.remoteName, `github-desktop-${source.owner}`)
    assert.equal(remoteBranch.nameWithoutRemote, "main")
    git(repo, "remote", "set-url", `github-desktop-${source.owner}`, `git@${kind}.example:${source.owner}/fork.git`)
    assert.equal(await findPullRequestBranch(repo, source, adapter, prefix), name)
    assert.equal(fetches, 1, "existing tracking branch is reused without fetching")
    git(repo, "branch", "--unset-upstream", name)
    await assert.rejects(findPullRequestBranch(repo, source, adapter, prefix), /already exists/)
    assert.equal(git(repo, "rev-parse", name), git(fork, "rev-parse", "HEAD"), "collision never resets local work")
    git(repo, "branch", "--set-upstream-to", `github-desktop-${source.owner}/main`, name)
    git(repo, "checkout", "main")
    writeFileSync(join(repo, "drag.txt"), "first\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "drag first")
    const first = git(repo, "rev-parse", "HEAD")
    writeFileSync(join(repo, "drag.txt"), "first\nsecond\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "drag second")
    const second = git(repo, "rev-parse", "HEAD")
    writeFileSync(join(repo, "local.txt"), "uncommitted work\n")
    await cherryPickToPullRequest(repo, source, [first, second], adapter, async () => false, prefix)
    assert.equal(git(repo, "branch", "--show-current"), "main", "cancel never switches branches")
    assert.equal(git(repo, "rev-parse", name), git(fork, "rev-parse", "HEAD"), "cancel never applies commits")
    await assert.rejects(
      cherryPickToPullRequest(
        repo,
        source,
        [first, second],
        {
          ...adapter,
          checkout: async () => {
            throw new Error("checkout blocked")
          }
        },
        async () => true,
        prefix
      ),
      /checkout blocked/
    )
    assert.equal(git(repo, "rev-parse", "HEAD"), second, "checkout failure never cherry-picks on source")
    await cherryPickToPullRequest(repo, source, [first, second], adapter, async () => true, prefix)
    assert.equal(git(repo, "branch", "--show-current"), name)
    assert.equal(git(repo, "show", "HEAD:drag.txt"), "first\nsecond")
    assert.equal(git(repo, "log", "-2", "--format=%s"), "drag second\ndrag first")
    assert.equal(git(repo, "rev-parse", "main"), second, "source history is unchanged")
    const applied = git(repo, "rev-parse", "HEAD")
    await cherryPickToPullRequest(repo, source, [first, second], adapter, async () => true, prefix)
    assert.equal(git(repo, "rev-parse", "HEAD"), applied, "drop onto current request is a no-op")
  })
}

// GitCub state adapter regression; upstream menu-template assertions stay unchanged.
it("repository menu disables unsafe actions while busy, detached or conflicted", async () => {
  const { repositoryMenuState } = await import("../../src/lib/menu/repository-menu-state")
  const context = {
    state: { selectedRepository: "/repo" } as import("../../src/models/app-state").AppState,
    status: {
      branch: "feature",
      changes: [],
      remote: "origin",
      hasUpstream: true,
      ahead: 1,
      behind: 1,
      operation: null,
      theirs: null,
      unborn: false,
      head: null,
      fetchHead: null,
      pullWithRebase: null
    },
    busy: false,
    remote: { host: "gitlab.example", owner: "group/sub", name: "project" },
    stashesVisible: false,
    filterVisible: true,
    hasStashes: true,
    platform: "gitlab" as const
  }
  assert.equal(repositoryMenuState(context, "main")["create-pull-request"], true)
  assert.equal(repositoryMenuState(context, "main")["delete-branch"], true)
  assert.equal(
    repositoryMenuState({ ...context, status: { ...context.status, branch: "main" } }, "main")["delete-branch"],
    false
  )
  assert.equal(repositoryMenuState({ ...context, busy: true }, "main").push, false)
  assert.equal(repositoryMenuState({ ...context, state: null }, "main")["show-changes"], false)
  assert.equal(
    repositoryMenuState({ ...context, status: { ...context.status, branch: null } }, "main")["merge-branch"],
    false
  )
  assert.equal(
    repositoryMenuState(
      {
        ...context,
        status: {
          ...context.status,
          changes: [
            { path: "a", kind: "unstaged", change: "conflicted", oldPath: null, conflict: null, submodule: null }
          ]
        }
      },
      "main"
    )["stash-all-changes"],
    false
  )
})

it("native menu request lookup uses the effective push URL instead of the fetch repository", async t => {
  const repo = mkdtempSync(join(tmpdir(), "gitcub-menu-push-url-"))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("remote", "add", "origin", "https://github.example/upstream/project.git")
  git("config", "remote.origin.pushurl", "git@github.example:contributor/project.git")
  assert.equal(await ipc.remotePushUrl(repo, "origin"), "git@github.example:contributor/project.git")
  assert.deepEqual(await ipc.parseRemote(await ipc.remotePushUrl(repo, "origin")), {
    host: "github.example",
    owner: "contributor",
    name: "project"
  })
  git("config", "--add", "remote.origin.pushurl", "git@other.example:contributor/project.git")
  await assert.rejects(ipc.remotePushUrl(repo, "origin"), /single destination/)
})
