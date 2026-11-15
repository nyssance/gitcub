import assert from "node:assert/strict"
import { after, it } from "node:test"

import type { CheckRun } from "../../src/models/app-state"
import { GitHubRepository } from "../../src/models/github-repository"
import { Owner } from "../../src/models/owner"
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { __TAURI_OS_PLUGIN_INTERNALS__: { platform: "macos" } }
})
const { ipc } = await import("../../src/lib/ipc")
const { ChecksDispatcher } = await import("../../src/ui/check-runs/native-checks-dispatcher")
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
})

const repository = new GitHubRepository("project", new Owner("team", "https://gitlab.example", 1), 1, null, null)
const remote = { host: "gitlab.example", owner: "team", name: "project" }
const run: CheckRun = {
  id: 1,
  name: "build",
  status: "completed",
  conclusion: "success",
  url: "",
  retry: null
}

it("subscribers share a scan and removing one does not discard another's result", async () => {
  const original = ipc.checkRuns
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<CheckRun[]>()
  let calls = 0
  ipc.checkRuns = async () => {
    calls++
    entered.resolve()
    return release.promise
  }
  const dispatcher = new ChecksDispatcher(
    remote,
    "sha",
    "",
    () => {},
    () => {}
  )
  let removedUpdates = 0
  const delivered = Promise.withResolvers<void>()
  const first = dispatcher.subscribeToCommitStatus(repository, "sha", () => {
    removedUpdates++
  })
  const second = dispatcher.subscribeToCommitStatus(repository, "sha", () => delivered.resolve())
  try {
    await entered.promise
    assert.equal(calls, 1)
    first.dispose()
    release.resolve([run])
    await delivered.promise
    assert.equal(removedUpdates, 0)
    assert.equal(dispatcher.tryGetCommitStatus(repository, "sha")?.checks[0].name, "build")
  } finally {
    first.dispose()
    second.dispose()
    ipc.checkRuns = original
  }
})

it("last unsubscribe cancels delivery and a new subscription ignores the old response", async () => {
  const original = ipc.checkRuns
  const entered = Promise.withResolvers<void>()
  const old = Promise.withResolvers<CheckRun[]>()
  let calls = 0
  ipc.checkRuns = async () => {
    if (++calls === 1) {
      entered.resolve()
      return old.promise
    }
    return [{ ...run, name: "fresh" }]
  }
  const errors: (string | null)[] = []
  const dispatcher = new ChecksDispatcher(
    remote,
    "sha",
    "",
    () => {},
    error => errors.push(error)
  )
  const subscription = dispatcher.subscribeToCommitStatus(repository, "sha", () => assert.fail("stale delivery"))
  let replacement: ReturnType<typeof dispatcher.subscribeToCommitStatus> | undefined
  try {
    await entered.promise
    subscription.dispose()
    const delivered = Promise.withResolvers<void>()
    replacement = dispatcher.subscribeToCommitStatus(repository, "sha", () => delivered.resolve())
    await delivered.promise
    old.reject(new Error("stale failure"))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(dispatcher.tryGetCommitStatus(repository, "sha")?.checks[0].name, "fresh")
    assert.deepEqual(errors, [null])
    assert.equal(calls, 2)
  } finally {
    subscription.dispose()
    replacement?.dispose()
    ipc.checkRuns = original
  }
})
