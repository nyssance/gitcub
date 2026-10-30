import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"

import {
  BranchWorkflowError,
  checkoutWithStash,
  cherryPickToBranch,
  pushWithRecovery
} from "../../src/lib/branch-workflows"
import { ipc } from "../../src/lib/ipc"
import { push } from "../../src/lib/push"
import type { RepoStatus } from "../../src/models/repo-status"
import { UncommittedChangesStrategy } from "../../src/upstream/models/uncommitted-changes-strategy"

const clean: RepoStatus = {
  branch: "feature",
  changes: [],
  remote: "origin",
  hasUpstream: true,
  ahead: 1,
  behind: 0,
  operation: null,
  theirs: null
}
const dirty: RepoStatus = {
  ...clean,
  changes: [{ path: "local.txt", kind: "unstaged", change: "modified", oldPath: null, conflict: null, submodule: null }]
}
function fixture() {
  const calls: string[] = []
  let status = { ...clean }
  const stashes: Record<string, string> = {}
  const git = {
    repoStatus: async () => status,
    lastBranchStash: async (_repo: string, branch: string) =>
      stashes[branch] ? { name: "stash@{0}", sha: stashes[branch], message: "", ours: true } : null,
    dropStashSha: async (_repo: string, sha: string) => {
      calls.push(`drop ${sha}`)
    },
    popStashSha: async (_repo: string, sha: string) => {
      calls.push(`pop ${sha}`)
    },
    branchDetails: async () => [],
    checkout: async (_repo: string, branch: string) => {
      calls.push(`checkout ${branch}`)
    },
    stashPush: async (_repo: string, branch: string) => {
      calls.push("stash")
      stashes[branch] = `new-${branch}`
    },
    cherryPick: async () => {
      calls.push("cherry-pick")
    },
    pull: async () => {
      calls.push("pull")
    },
    push: async () => {
      calls.push("push")
      throw new Error("[rejected] (fetch first)")
    }
  }
  return {
    calls,
    git,
    stashes,
    setStatus: (value: RepoStatus) => {
      status = value
    }
  }
}

it("push recovery is cancelled without pulling or escalating to force", async () => {
  const { calls, git } = fixture()
  await assert.rejects(
    pushWithRecovery("repo", false, git, async () => false),
    /fetch first/
  )
  assert.deepEqual(calls, ["push"])
})
for (const error of ["remote rejected: protected branch", "pre-receive hook declined", "permission denied"]) {
  it(`push does not offer history rewriting for ${error}`, async () => {
    const { git } = fixture()
    await assert.rejects(
      pushWithRecovery(
        "repo",
        false,
        {
          ...git,
          push: async () => {
            throw new Error(error)
          }
        },
        async () => {
          assert.fail("unexpected recovery confirmation")
        }
      ),
      new RegExp(error)
    )
  })
}
it("a pull conflict stops recovery before another push", async () => {
  const { calls, git } = fixture()
  await assert.rejects(
    pushWithRecovery(
      "repo",
      false,
      {
        ...git,
        pull: async () => {
          calls.push("pull")
          throw new Error("conflict")
        }
      },
      async () => true
    ),
    /conflict/
  )
  assert.deepEqual(calls, ["push", "pull"])
})
it("changing branches during push confirmation prevents pulling into the wrong branch", async () => {
  const { calls, git, setStatus } = fixture()
  await assert.rejects(
    pushWithRecovery("repo", false, git, async () => {
      setStatus({ ...clean, branch: "other" })
      return true
    }),
    /changed/
  )
  assert.deepEqual(calls, ["push"])
})
it("explicit force failure is not retried or converted into pull", async () => {
  const { calls, git } = fixture()
  await assert.rejects(
    pushWithRecovery("repo", true, git, async () => assert.fail("unexpected confirmation")),
    /fetch first/
  )
  assert.deepEqual(calls, ["push"])
})
it("force confirmation cannot authorize a different branch after an external checkout", async () => {
  const { calls, git, setStatus } = fixture()
  await assert.rejects(
    pushWithRecovery(
      "repo",
      true,
      git,
      async () => false,
      async () => {
        setStatus({ ...clean, branch: "other" })
        return true
      }
    ),
    error => error instanceof BranchWorkflowError && error.code === "branchChanged"
  )
  assert.deepEqual(calls, [])
})
it("cancelled force confirmation performs no transport", async () => {
  const { calls, git } = fixture()
  await pushWithRecovery(
    "repo",
    true,
    git,
    async () => false,
    async () => false
  )
  assert.deepEqual(calls, [])
})
const prompts = (choice: boolean | "carry", overwrite = true) => {
  const asked: string[] = []
  return {
    asked,
    prompts: {
      stashAndSwitch: async (target: string, current: string, hasStash: boolean) => {
        asked.push(`switch ${current}->${target}${hasStash ? " (has stash)" : ""}`)
        return choice
      },
      overwriteStash: async () => {
        asked.push("overwrite")
        return overwrite
      }
    }
  }
}
it("checkout recovery preserves local changes if the branch changes during confirmation", async () => {
  const { calls, git, setStatus } = fixture()
  setStatus(dirty)
  await assert.rejects(
    checkoutWithStash("repo", "target", git, {
      stashAndSwitch: async () => {
        setStatus({ ...dirty, branch: "other" })
        return true
      },
      overwriteStash: async () => true
    }),
    /changed/
  )
  assert.deepEqual(calls, [])
})
// Desktop _checkoutBranch：策略是「每次询问」且有更改时，切换前就问，不等 Git 拒绝
it("checkout asks where local changes go before switching", async () => {
  const { calls, git, setStatus } = fixture()
  setStatus(dirty)
  const { asked, prompts: p } = prompts(false)
  await checkoutWithStash("repo", "target", git, p)
  assert.deepEqual(asked, ["switch feature->target"])
  assert.deepEqual(calls, [])
})
it("checkout without local changes switches without asking", async () => {
  const { calls, git } = fixture()
  const { asked, prompts: p } = prompts(true)
  await checkoutWithStash("repo", "target", git, p)
  assert.deepEqual(asked, [])
  assert.deepEqual(calls, ["checkout target"])
})
// Desktop checkoutAndLeaveChanges → createStashAndDropPreviousEntry；已有贮藏先 ConfirmOverwriteStash
it("leaving changes on the current branch replaces that branch's previous stash after confirming", async () => {
  const { calls, git, setStatus, stashes } = fixture()
  setStatus(dirty)
  stashes.feature = "old"
  const { asked, prompts: p } = prompts(true)
  await checkoutWithStash("repo", "target", git, p)
  assert.deepEqual(asked, ["switch feature->target (has stash)", "overwrite"])
  assert.deepEqual(calls, ["stash", "drop old", "checkout target"])
})
it("declining to overwrite the existing stash leaves everything in place", async () => {
  const { calls, git, setStatus, stashes } = fixture()
  setStatus(dirty)
  stashes.feature = "old"
  await checkoutWithStash("repo", "target", git, prompts(true, false).prompts)
  assert.deepEqual(calls, [])
})
// Desktop checkoutAndBringChanges：先直接切换，被更改拦下才临时贮藏（记在目标分支名下）、切换、弹出
it("bringing changes retries through a transient stash only when Git refuses", async () => {
  const { calls, git, setStatus } = fixture()
  setStatus(dirty)
  let refused = false
  await checkoutWithStash(
    "repo",
    "target",
    {
      ...git,
      checkout: async (repo: string, branch: string) => {
        if (!refused) {
          refused = true
          throw new Error("error: Your local changes to the following files would be overwritten by checkout")
        }
        await git.checkout(repo, branch)
      }
    },
    prompts("carry").prompts
  )
  assert.deepEqual(calls, ["stash", "checkout target", "pop new-target"])
})
it("the preference to always stash skips the question", async () => {
  const { calls, git, setStatus } = fixture()
  setStatus(dirty)
  const { asked, prompts: p } = prompts(false)
  await checkoutWithStash("repo", "target", git, p, UncommittedChangesStrategy.StashOnCurrentBranch)
  assert.deepEqual(asked, [])
  assert.deepEqual(calls, ["stash", "checkout target"])
})
it("detached HEAD always brings changes along", async () => {
  const { calls, git, setStatus } = fixture()
  setStatus({ ...dirty, branch: null })
  const { asked, prompts: p } = prompts(false)
  await checkoutWithStash("repo", "target", git, p)
  assert.deepEqual(asked, [])
  assert.deepEqual(calls, ["checkout target"])
})
it("history cherry-pick cancellation does not move local modifications to another branch", async () => {
  const { calls, git, setStatus } = fixture()
  setStatus({
    ...clean,
    changes: [{ path: "local.txt", kind: "untracked", change: "added", oldPath: null, conflict: null, submodule: null }]
  })
  await cherryPickToBranch("repo", "target", ["a"], git, async () => false)
  assert.deepEqual(calls, [])
})
for (const status of [
  { ...clean, branch: null },
  { ...clean, operation: "rebase" as const }
]) {
  it(`cherry-pick rejects ${status.branch === null ? "detached HEAD" : "unfinished rebase"} before writing`, async () => {
    const { calls, git, setStatus } = fixture()
    setStatus(status)
    await assert.rejects(
      cherryPickToBranch("repo", "target", ["a"], git, async () => true),
      error =>
        error instanceof BranchWorkflowError &&
        error.code === (status.branch === null ? "detached" : "operationInProgress")
    )
    assert.deepEqual(calls, [])
  })
}

it("rejected push pulls the actual tracking remote and pushes both histories through Rust", async t => {
  const root = mkdtempSync(join(tmpdir(), "gitcub-push-recovery-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (path: string, ...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim()
  const remote = join(root, "remote.git"),
    repo = join(root, "repo"),
    peer = join(root, "peer")
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote])
  execFileSync("git", ["clone", "-q", remote, repo])
  git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base")
  git(repo, "push", "-u", "origin", "main")
  execFileSync("git", ["clone", "-q", remote, peer])
  git(repo, "remote", "rename", "origin", "review")
  git(repo, "config", "pull.rebase", "false")
  git(repo, "config", "commit.gpgsign", "false")
  writeFileSync(join(repo, "local.txt"), "local\n")
  git(repo, "add", ".")
  git(repo, "commit", "-m", "local work")
  const local = git(repo, "rev-parse", "HEAD")
  writeFileSync(join(peer, "peer.txt"), "peer\n")
  git(peer, "add", ".")
  git(peer, "-c", "commit.gpgsign=false", "commit", "-m", "peer work")
  git(peer, "push")
  const other = git(peer, "rev-parse", "HEAD")
  let confirmations = 0
  await pushWithRecovery(
    repo,
    false,
    {
      ...ipc,
      push: (path, remote, branch, target, forceWithLease) =>
        push({ path }, { name: remote }, branch, target, null, { forceWithLease })
    },
    async () => {
      confirmations++
      return true
    }
  )
  assert.equal(confirmations, 1)
  assert.equal(git(remote, "rev-parse", "main"), git(repo, "rev-parse", "HEAD"))
  git(repo, "merge-base", "--is-ancestor", local, "HEAD")
  git(repo, "merge-base", "--is-ancestor", other, "HEAD")
  assert.equal(git(repo, "show", "HEAD:local.txt"), "local")
  assert.equal(git(repo, "show", "HEAD:peer.txt"), "peer")
})

// GitLens operations.test.ts / operations.upstreamRemote.test.ts found both: the remote fell back to
// `branch.<name>.remote = .` (a push into this repository, moving the local upstream) or to a literal "origin"
// (a relative path Git accepts as a destination) instead of refusing.
it("a push with no remote to push to is refused before any transport", async t => {
  const root = mkdtempSync(join(tmpdir(), "gitcub-push-no-remote-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (path: string, ...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim()
  const commit = (path: string, message: string) =>
    git(
      path,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t.t",
      "commit",
      "--allow-empty",
      "-m",
      message
    )
  const repo = join(root, "repo")
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  commit(repo, "base")
  git(repo, "checkout", "-q", "--track", "-b", "feature", "main")
  commit(repo, "feature")
  const main = git(repo, "rev-parse", "main")
  const transport = {
    ...ipc,
    push: (path: string, remote: string, branch: string, target: string | null, forceWithLease: boolean) =>
      push({ path }, { name: remote }, branch, target, null, { forceWithLease })
  }
  const refused = (error: unknown) => error instanceof BranchWorkflowError && error.code === "noUpstream"
  await assert.rejects(
    pushWithRecovery(repo, true, transport, async () => false),
    refused
  )
  assert.equal(git(repo, "rev-parse", "main"), main, "the local upstream must not move")

  git(repo, "config", "--unset", "branch.feature.remote")
  git(repo, "config", "--unset", "branch.feature.merge")
  execFileSync("git", ["init", "-q", "--bare", join(repo, "origin")])
  await assert.rejects(
    pushWithRecovery(repo, false, transport, async () => false),
    refused
  )
  assert.equal(git(join(repo, "origin"), "for-each-ref"), "", "nothing lands in a directory named origin")
})

// Own regression, Desktop `performPush` (app-store.ts): `branch.upstreamRemoteName || remote.name`, with the remote
// name taken from `%(upstream:short)`. A local upstream has no remote prefix, so the branch goes to the current remote
// without a remote branch, which `git/push.ts` publishes with `--set-upstream`; the local upstream does not move.
it("a branch tracking a local branch pushes to the current remote as Desktop does", async t => {
  const root = mkdtempSync(join(tmpdir(), "gitcub-push-local-upstream-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (path: string, ...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim()
  const commit = (path: string) =>
    git(
      path,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t.t",
      "commit",
      "--allow-empty",
      "-m",
      "c"
    )
  const repo = join(root, "repo")
  const origin = join(root, "origin.git")
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  execFileSync("git", ["init", "-q", "--bare", origin])
  git(repo, "remote", "add", "origin", origin)
  commit(repo)
  git(repo, "checkout", "-q", "--track", "-b", "feature", "main")
  commit(repo)
  const main = git(repo, "rev-parse", "main")
  const pushed: [string, string | null][] = []
  const transport = {
    ...ipc,
    push: (path: string, remote: string, branch: string, target: string | null, forceWithLease: boolean) => {
      pushed.push([remote, target])
      return push({ path }, { name: remote }, branch, target, null, { forceWithLease })
    }
  }
  await pushWithRecovery(repo, false, transport, async () => false)
  assert.deepEqual(pushed, [["origin", null]])
  assert.equal(git(origin, "rev-parse", "refs/heads/feature"), git(repo, "rev-parse", "feature"))
  assert.equal(git(repo, "rev-parse", "main"), main, "the local upstream must not move")
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "feature@{upstream}"), "origin/feature")
})
