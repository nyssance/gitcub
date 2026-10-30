import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { invoke as nativeInvoke } from "@tauri-apps/api/core"

import type { RepoStatus } from "../../src/models/repo-status"
import { expect, skipWelcome, test } from "./e2e/fixtures.ts"
import { smokeRepoName } from "./upstream/desktop/e2e/test-helpers.ts"

declare global {
  interface Window {
    __TAURI_INTERNALS__: { invoke: typeof nativeInvoke }
    __slowStatus: { done: boolean; result?: RepoStatus; error?: string }
    __blockedHistory: { done: boolean; error?: string }
  }
}

test("a blocked status scan leaves native IPC and the WebView responsive", async ({ mainWindow: page }) => {
  await page.waitForSelector("body", { state: "visible", timeout: 30000 })
  const directory = mkdtempSync(join(tmpdir(), "gitcub-status-responsive-"))
  const repo = join(directory, "repo")
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  git("init", "-q")
  const file = join(repo, "tracked.txt")
  writeFileSync(file, "unchanged content\n")
  git("add", "tracked.txt")
  const started = join(directory, "started")
  const release = join(directory, "release")
  const filter = join(directory, "filter.cjs")
  writeFileSync(
    filter,
    `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, '');
    const deadline = setTimeout(() => process.exit(1), 30000);
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer);
      clearTimeout(deadline);
      process.stdin.pipe(process.stdout);
    }, 20);
  `
  )
  const quote = (value: string) => `'${value.replaceAll("'", String.raw`'\''`)}'`
  git("config", "filter.slow.clean", `${quote(process.execPath)} ${quote(filter)}`)
  git("config", "filter.slow.required", "true")
  writeFileSync(join(repo, ".gitattributes"), "tracked.txt filter=slow\n")
  // Force a content check without changing the tracked file's bytes or size.
  const timestamp = new Date(Date.now() - 60_000)
  utimesSync(file, timestamp, timestamp)
  try {
    await page.evaluate(path => {
      window.__slowStatus = { done: false }
      void window.__TAURI_INTERNALS__.invoke<RepoStatus>("repo_status", { repo: path }).then(
        result => {
          window.__slowStatus = { done: true, result }
        },
        error => {
          window.__slowStatus = { done: true, error: String(error) }
        }
      )
    }, repo)
    await expect.poll(() => existsSync(started)).toBe(true)
    const before = Date.now()
    const responsive = await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("load_state")
      return { ready: document.readyState, pending: !window.__slowStatus.done }
    })
    assert.equal(responsive.ready, "complete")
    assert.equal(responsive.pending, true)
    assert.ok(Date.now() - before < 5000, "native IPC must finish while status is still blocked")
  } finally {
    writeFileSync(release, "")
  }
  await expect.poll(() => page.evaluate(() => window.__slowStatus.done)).toBe(true)
  const result = await page.evaluate(() => window.__slowStatus)
  assert.equal(result.error, undefined)
  assert.ok(result.result?.changes.some(change => change.path === "tracked.txt"))
})

test("a partial-clone history fetch cannot block navigation or other native commands", async ({ mainWindow: page }) => {
  await skipWelcome(page, "Responsiveness Test", "test@example.invalid")
  const directory = mkdtempSync(join(tmpdir(), "gitcub-history-responsive-"))
  const source = join(directory, "source")
  const repo = join(directory, "partial")
  mkdirSync(source)
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
    }).trim()
  git(source, "init", "-q", "-b", "main")
  git(source, "config", "user.name", "Test")
  git(source, "config", "user.email", "test@example.invalid")
  git(source, "config", "uploadpack.allowFilter", "true")
  git(source, "config", "uploadpack.allowAnySHA1InWant", "true")
  writeFileSync(join(source, "file.txt"), "first\n")
  git(source, "add", ".")
  git(source, "commit", "-qm", "first")
  // Deleting a file next to an addition makes rename detection score the pair; the
  // blobs are missing from the partial clone, so commit_files leaves its in-process
  // path and runs git, which lazily fetches them.
  writeFileSync(join(source, "added.txt"), "added\n")
  git(source, "rm", "-q", "file.txt")
  git(source, "add", ".")
  git(source, "commit", "-qm", "second")
  git(directory, "clone", "--filter=blob:none", "--no-checkout", pathToFileURL(source).href, repo)
  const sha = git(repo, "rev-parse", "HEAD")
  const started = join(directory, "started")
  const release = join(directory, "release")
  const remote = join(directory, "remote.cjs")
  writeFileSync(
    remote,
    `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, '');
    const deadline = setTimeout(() => process.exit(1), 30000);
    setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearTimeout(deadline); process.exit(1); } }, 20);
  `
  )
  git(repo, "config", "protocol.ext.allow", "always")
  git(repo, "remote", "set-url", "origin", `ext::${process.execPath} ${remote}`)
  try {
    await page.evaluate(
      ({ repo, sha }) => {
        window.__blockedHistory = { done: false }
        void window.__TAURI_INTERNALS__.invoke("commit_files", { repo, sha }).then(
          () => {
            window.__blockedHistory = { done: true }
          },
          error => {
            window.__blockedHistory = { done: true, error: String(error) }
          }
        )
      },
      { repo, sha }
    )
    await expect.poll(() => existsSync(started)).toBe(true)
    const before = Date.now()
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("load_state")
    })
    // The rail's "Discover" entry opens the embedded Trending board since
    // 2026-10-22; the hosted repository tabs now live under the GitCub header.
    await page.locator('.repository-rail [data-slot="sidebar-header"] button:has-text("GitCub")').click()
    await page.waitForSelector('[role="tablist"][aria-label="Discover"]', { state: "visible" })
    // A local repository without a remote is listed under "Third-party".
    await page.locator('[data-slot="tabs-trigger"]:has-text("Third-party")').click()
    await page.locator(`button:has-text("${smokeRepoName}")`).click()
    assert.equal(await page.evaluate(() => !window.__blockedHistory.done), true)
    assert.ok(Date.now() - before < 5000, "navigation must finish before the blocked fetch returns")
  } finally {
    writeFileSync(release, "")
  }
  await expect.poll(() => page.evaluate(() => window.__blockedHistory.done)).toBe(true)
  assert.equal(
    await page.evaluate(() => Boolean(window.__blockedHistory.error)),
    true,
    "a failed lazy fetch must report an error"
  )
})

test("the native Trending board opens lazily and leaves the mounted workspace responsive", async ({
  mainWindow: page
}) => {
  const initial = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const state = await invoke<{ canvasTrackpadGestures: boolean }>("load_state")
    // Same payload shape as atlas-tauri's TrackpadGesture; Atlas rejects partial events.
    for (const [phase, dx, totalDx] of [
      ["began", 0, 0],
      ["changed", 0.8, 0.8],
      ["ended", 0, 0.8]
    ] as const) {
      await invoke("plugin:event|emit", {
        event: "trackpad-gesture",
        payload: { fingers: 3, phase, dx, dy: 0, totalDx, totalDy: 0, ts: performance.now() }
      })
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    return {
      available: await invoke<boolean>("has_trackpad"),
      enabled: state.canvasTrackpadGestures,
      page: document.querySelector("[data-floating-workspace]")?.getAttribute("data-page")
    }
  })
  assert.equal(initial.enabled, false)
  assert.equal(initial.page, "1", "trackpad gestures must be ignored by default")
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "preferences" })
  )
  await page.locator('[role="tab"]:has-text("Trackpad")').click()
  const toggle = page.locator('[role="switch"][aria-label="Three-finger canvas swiping"]')
  if (initial.available) await toggle.click()
  else
    assert.equal(
      await page.evaluate(() => {
        const toggle = document.querySelector('[role="switch"][aria-label="Three-finger canvas swiping"]')
        return toggle?.matches(":disabled") || toggle?.getAttribute("aria-disabled") === "true"
      }),
      true
    )
  await page.locator('[data-slot="dialog-close"]').click()
  await page.waitForSelector('[role="dialog"]', { state: "hidden" })
  // Hasgard targets a WebviewWindow. Run the multi-webview interaction in one
  // evaluation and close the child before returning to the driver.
  const result = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const wait = async (condition: () => boolean | Promise<boolean>) => {
      const until = Date.now() + 6000
      while (!(await condition())) {
        if (Date.now() > until)
          throw new Error(
            `Native Trending transition timed out: ${JSON.stringify({
              page: document.querySelector("[data-floating-workspace]")?.getAttribute("data-page"),
              workspaceX: document.querySelector('[data-floating-board="workspace"]')?.getBoundingClientRect().x,
              track: document.querySelector("[data-canvas-track]")?.getAttribute("style")
            })}`
          )
        await new Promise(resolve => setTimeout(resolve, 30))
      }
    }
    const views = () => invoke<{ label: string }[]>("plugin:webview|get_all_webviews")
    // Exercise the hardware-independent mouse path on machines without a trackpad.
    const available = await invoke<boolean>("has_trackpad")
    const swipe = async (dx: number) => {
      const root = document.querySelector<HTMLElement>("[data-canvas-viewport]")!
      let x = 0
      let total = 0
      const emit = async (phase: string, delta = 0) => {
        if (available) {
          total += delta
          await invoke("plugin:event|emit", {
            event: "trackpad-gesture",
            payload: { fingers: 3, phase, dx: delta, dy: 0, totalDx: total, totalDy: 0, ts: performance.now() }
          })
        } else {
          x += delta * root.clientWidth
          // Atlas keeps a middle-button pan only while `buttons` still has the middle bit set.
          root.dispatchEvent(
            new PointerEvent(phase === "began" ? "pointerdown" : phase === "changed" ? "pointermove" : "pointerup", {
              bubbles: true,
              cancelable: true,
              button: 1,
              buttons: phase === "ended" ? 0 : 4,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
              clientX: x
            })
          )
        }
      }
      await emit("began")
      for (let i = 0; i < 12; i++) {
        await emit("changed", dx / 12)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await emit("ended")
    }
    const before = await views()
    const workspace = document.querySelector('[data-floating-board="workspace"]')
    const navigation = document.querySelector("[data-canvas-navigation]")
    try {
      await swipe(0.8)
      await wait(async () => (await views()).some(view => view.label === "github-trending"))
      await invoke("load_state")
      const position = await invoke<{ x: number; y: number }>("plugin:webview|webview_position", {
        label: "github-trending"
      })
      const size = await invoke<{ width: number; height: number }>("plugin:webview|webview_size", {
        label: "github-trending"
      })
      const { x, y, width, height } = document.querySelector("[data-trending-webview]")!.getBoundingClientRect()
      const navigationOnRight = navigation!.getBoundingClientRect().x > innerWidth / 2
      await swipe(-0.8)
      await wait(() => Math.abs(workspace!.getBoundingClientRect().x - 256) < 1)
      await invoke("load_state")
      return {
        lazy: !before.some(view => view.label === "github-trending"),
        navigationOnRight,
        sameNavigation: document.querySelector("[data-canvas-navigation]") === navigation,
        sameWorkspace: document.querySelector('[data-floating-board="workspace"]') === workspace,
        page: document.querySelector("[data-floating-workspace]")?.getAttribute("data-page"),
        position,
        size,
        frame: { x, y, width, height },
        scale: window.devicePixelRatio
      }
    } finally {
      // Replacing the renderer session with an inactive session disposes its child.
      await invoke("sync_trending_webview", {
        session: "native-test-cleanup",
        frame: { x: 0, y: 0, width: 1, height: 1, visible: false },
        reload: false,
        onLoad: "__CHANNEL__:0"
      })
      await wait(async () => !(await views()).some(view => view.label === "github-trending"))
    }
  })
  assert.equal(result.lazy, true)
  assert.equal(result.sameWorkspace, true)
  assert.equal(result.sameNavigation, true)
  assert.equal(result.navigationOnRight, true)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const state = await window.__TAURI_INTERNALS__.invoke<{ canvasTrackpadGestures: boolean }>("load_state")
        return state.canvasTrackpadGestures
      })
    )
    .toBe(initial.available)
  assert.equal(result.page, "1")
  for (const key of ["x", "y"] as const)
    assert.ok(Math.abs(result.position[key] / result.scale - result.frame[key]) <= 1)
  for (const key of ["width", "height"] as const)
    assert.ok(Math.abs(result.size[key] / result.scale - result.frame[key]) <= 1)
})
