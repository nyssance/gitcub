import type { invoke as nativeInvoke } from "@tauri-apps/api/core"

import type { AppState } from "../../src/models/app-state"
declare global {
  interface Window {
    __TAURI_INTERNALS__: { invoke: typeof nativeInvoke }
    __restoreRequestIPC: () => void
    __requestTargets: { owner: string; name: string }[]
    __commitDrag: DataTransfer
    __workflowCalls: { command: string; repo: string }[]
    __releasePush: () => void
  }
}
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"

import { expect, type Page, recordNativeMemory, skipWelcome, test } from "./e2e/fixtures.ts"
import { smokeRepoPath } from "./upstream/desktop/e2e/test-helpers.ts"
const git = (...args: string[]) => execFileSync("git", ["-C", smokeRepoPath, ...args], { encoding: "utf8" }).trim()

test("first-run Desktop import can be declined and stays declined after reload", async ({ mainWindow: page }) => {
  await page.locator('button:has-text("Not now")').waitFor({ state: "visible", timeout: 30000 })
  const disabled = await page.evaluate(
    () =>
      [...document.querySelectorAll("button")].find(button =>
        button.textContent?.includes("Import from GitHub Desktop")
      )?.disabled
  )
  assert.equal(disabled, true)
  await page.locator('button:has-text("Not now")').click()
  await page.locator('button:has-text("Sign in to GitHub.com")').waitFor({ state: "visible", timeout: 30000 })
  const state = await page.evaluate(async () => window.__TAURI_INTERNALS__.invoke<AppState>("load_state"))
  assert.equal(state.desktopImportHandled, true)
  assert.deepEqual(state.repositories, [smokeRepoPath])
  await page.evaluate(() => location.reload())
  await page.locator('button:has-text("Sign in to GitHub.com")').waitFor({ state: "visible", timeout: 30000 })
  assert.equal(await page.locator('button:has-text("Not now")').isVisible(), false)
})

test("welcome opens the same GitHub/GitLab account settings and cancels cleanly", async ({ mainWindow: page }) => {
  await page.locator('button:has-text("Sign in to GitHub.com")').waitFor({ state: "visible", timeout: 30000 })
  await page.locator('button:has-text("Sign in to GitHub.com")').click()
  await page.locator('[role="dialog"]').waitFor({ state: "visible" })
  await expect(page.locator('[role="dialog"]')).toContainText("github.com")
  await expect(page.locator('[role="dialog"]')).toContainText("gitlab.com")
  // Component navigation, alignment and keyboard assertions live in stories/preferences.stories.tsx.
  await page.keyboard.press("Escape")
  await page.locator('[role="dialog"]').waitFor({ state: "hidden" })
  await skipWelcome(page, "GitCub macOS E2E", "macos@example.invalid")
})

test("remote branch selection creates a local tracking branch through the real UI", async ({ mainWindow: page }) => {
  git("add", ".")
  git("-c", "commit.gpgsign=false", "commit", "-m", "seed macOS workflows")
  git("remote", "add", "origin", smokeRepoPath)
  git("update-ref", "refs/remotes/origin/remote-feature", "HEAD")
  await page.locator(".branch-button button").click()
  const remote = page.locator('.branches-list-item .name:has-text("origin/remote-feature")')
  await remote.waitFor({ state: "visible", timeout: 15000 })
  await remote.click()
  await expect.poll(() => git("branch", "--show-current")).toBe("remote-feature")
  assert.equal(git("rev-parse", "--abbrev-ref", "@{upstream}"), "origin/remote-feature")
  assert.equal(git("status", "--porcelain"), "")
})

test("a rebase conflict remains actionable after reloading the WebView", async ({ mainWindow: page }) => {
  const file = "recovery.txt"
  writeFileSync(join(smokeRepoPath, file), "base\n")
  git("add", file)
  git("commit", "-m", "recovery base")
  git("branch", "conflict-base")
  writeFileSync(join(smokeRepoPath, file), "feature\n")
  git("commit", "-am", "feature change")
  const before = git("rev-parse", "HEAD")
  git("checkout", "conflict-base")
  writeFileSync(join(smokeRepoPath, file), "base changed\n")
  git("commit", "-am", "base change")
  git("checkout", "remote-feature")
  await page.evaluate(async (repo: string) => {
    try {
      await window.__TAURI_INTERNALS__.invoke("rebase_with_progress", {
        repo,
        base: "conflict-base",
        target: null
      })
    } catch {
      // The fixture intentionally creates a rebase conflict; assert its visible recovery state below.
    }
  }, smokeRepoPath)
  assert.equal(git("diff", "--name-only", "--diff-filter=U"), file)
  await page.evaluate(() => {
    location.reload()
  })
  await page.locator('button:has-text("Abort")').waitFor({ state: "visible", timeout: 20000 })
  await page.locator('button:has-text("Abort")').click()
  const confirm = page.locator('[role="alertdialog"] button:has-text("Continue")')
  if (await confirm.isVisible()) await confirm.click()
  await expect.poll(() => git("diff", "--name-only", "--diff-filter=U"), { timeout: 15000 }).toBe("")
  assert.equal(git("rev-parse", "HEAD"), before)
  assert.equal(git("branch", "--show-current"), "remote-feature")
})

test("100000-line diff stays virtualized and the WebView remains responsive", async ({ mainWindow: page }) => {
  await recordNativeMemory("before-100000-line-diff")
  const file = "large-diff.txt"
  writeFileSync(join(smokeRepoPath, file), Array.from({ length: 100000 }, (_, n) => `large line ${n}\n`).join(""))
  const entry = page.locator('.list-scroller [title="large-diff.txt"]')
  await entry.waitFor({ state: "visible", timeout: 15000 })
  await entry.click()
  await page.locator(".diff-container .unified-diff").waitFor({ state: "visible", timeout: 20000 })
  const renderedLines = await page.evaluate(() => document.querySelectorAll(".unified-diff .row").length)
  assert.ok(renderedLines > 0 && renderedLines < 1000, `Expected virtualized lines, got ${renderedLines}`)
  await page.evaluate(() => {
    const scroll = document.querySelector(".unified-diff")
    if (scroll) scroll.scrollTop = scroll.scrollHeight
  })
  await expect(page.locator(".diff-container")).toContainText("large line 99999", { timeout: 15000 })
  await recordNativeMemory("after-100000-line-diff-scroll")
})

test("different-sized image revisions fit and switch modes in native WebKit", async ({ mainWindow: page }) => {
  const file = "image-sizes.png"
  const png = (width: number, height: number) => {
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type), data])
      const length = Buffer.alloc(4)
      length.writeUInt32BE(data.length)
      const checksum = Buffer.alloc(4)
      checksum.writeUInt32BE(crc32(body))
      return Buffer.concat([length, body, checksum])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header[8] = 8
    header[9] = 6
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
      chunk("IEND", Buffer.alloc(0))
    ])
  }
  writeFileSync(join(smokeRepoPath, file), png(1200, 300))
  git("add", "--", file)
  git("-c", "commit.gpgsign=false", "commit", "-m", "image sizing baseline")
  writeFileSync(join(smokeRepoPath, file), png(300, 1200))
  const entry = page.locator('.list-scroller [title="image-sizes.png"]')
  await entry.waitFor({ state: "visible", timeout: 15000 })
  await entry.click()
  await page.locator('img[alt="After"]').waitFor({ state: "visible" })
  for (const mode of ["Swipe", "Onion skin", "Difference"]) {
    await page.locator(`button:has-text("${mode}")`).click()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const images = [...document.querySelectorAll<HTMLImageElement>("[data-image-revision] img")]
          return (
            images.length === 2 &&
            images.every(image => {
              const bounds = image.getBoundingClientRect()
              const frame = image.parentElement!.getBoundingClientRect()
              return (
                image.naturalWidth > 0 &&
                bounds.width > 0 &&
                bounds.height > 0 &&
                Math.abs(bounds.width / bounds.height - image.naturalWidth / image.naturalHeight) < 0.01 &&
                bounds.width <= frame.width + 1 &&
                bounds.height <= frame.height + 1
              )
            })
          )
        })
      )
      .toBe(true)
  }
})

test("native and Desktop credentials share logout and reject stale writes", async ({ mainWindow: page }) => {
  const result = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const host = "credentials.example.invalid:8443"
    const service = `GitCub - https://${host}/api/v3`
    try {
      await invoke("set_token", { host, token: "first-test-token" })
      const first = await invoke("token_store_get", { service, login: "test-user" })
      await invoke("set_token", { host, token: "replacement-test-token" })
      let staleApiRejected = false
      try {
        await invoke("native_account_token", { host, token: "first-test-token" })
      } catch {
        staleApiRejected = true
      }
      const currentApiToken = await invoke("native_account_token", { host, token: "replacement-test-token" })
      let replacementRejected = false
      try {
        await invoke("token_store_set", { service, login: "test-user", value: "first-test-token" })
      } catch {
        replacementRejected = true
      }
      const replacement = await invoke("token_store_get", { service, login: "test-user" })
      await invoke("set_account_ignored", { host, ignored: true })
      const removed = await invoke("token_store_get", { service, login: "test-user" })
      let logoutRejected = false
      try {
        await invoke("token_store_set", { service, login: "test-user", value: "late-test-token" })
      } catch {
        logoutRejected = true
      }
      const otherPort = await invoke("token_store_get", {
        service: "GitCub - https://credentials.example.invalid:9443/api/v3",
        login: "test-user"
      })
      return {
        first,
        replacement,
        removed,
        replacementRejected,
        staleApiRejected,
        currentApiToken,
        logoutRejected,
        otherPort
      }
    } finally {
      await invoke("set_account_ignored", { host, ignored: true })
    }
  })
  assert.deepEqual(result, {
    first: "first-test-token",
    replacement: "replacement-test-token",
    removed: null,
    replacementRejected: true,
    staleApiRejected: true,
    currentApiToken: "replacement-test-token",
    logoutRejected: true,
    otherPort: null
  })
})

test("file change bursts converge to the final diff without reloading", async ({ mainWindow: page }) => {
  const file = "burst.txt"
  for (let n = 0; n < 100; n++) writeFileSync(join(smokeRepoPath, file), `burst revision ${n}\n`)
  const entry = page.locator('.list-scroller [title="burst.txt"]')
  await entry.waitFor({ state: "visible", timeout: 15000 })
  await entry.click()
  await expect(page.locator(".diff-container")).toContainText("burst revision 99", { timeout: 15000 })
  for (let n = 100; n < 200; n++) writeFileSync(join(smokeRepoPath, file), `burst revision ${n}\n`)
  await expect(page.locator(".diff-container")).toContainText("burst revision 199", { timeout: 15000 })
})

test("rotating native credentials preserve the Desktop secure-store contract", async ({ mainWindow: page }) => {
  const result = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const host = "rotating.example.invalid"
    const service = `GitCub - https://${host}/api/v3`
    const expiresAt = Math.floor(Date.now() / 1000) + 7200
    const token = `gitcub-oauth:${JSON.stringify({
      kind: "github",
      clientId: "fixture-client",
      accessToken: "current-access",
      refreshToken: "current-refresh",
      expiresAt,
      sessionToken: "first-access",
      previousTokens: ["first-access", "first-refresh"]
    })}`
    try {
      await invoke("set_token", { host, token })
      const value = await invoke<string>("token_store_get", { service, login: "test-user" })
      const credential = JSON.parse(value.slice("github-desktop-oauth:".length)).credential
      // Different JSON property order is semantically the same credential.
      await invoke("token_store_set", {
        service,
        login: "test-user",
        value: `github-desktop-oauth:${JSON.stringify({
          credential: {
            refreshToken: credential.refreshToken,
            accessToken: credential.accessToken,
            expiresAt: credential.expiresAt
          },
          version: 1
        })}`
      })
      const resolved = await invoke("native_account_token", { host, token: "first-access" })
      let replacedRejected = false
      try {
        await invoke("native_account_token", { host, token: "unrelated-account" })
      } catch {
        replacedRejected = true
      }
      return { credential, resolved, replacedRejected, expectedExpiry: expiresAt * 1000 }
    } finally {
      await invoke("set_account_ignored", { host, ignored: true })
    }
  })
  assert.deepEqual(result.credential, {
    accessToken: "current-access",
    refreshToken: "current-refresh",
    expiresAt: result.expectedExpiry
  })
  assert.equal(result.resolved, "current-access")
  assert.equal(result.replacedRejected, true)
})

test("diff layout, whitespace projection and search work through the native renderer", async ({ mainWindow: page }) => {
  const file = "diff-controls.txt"
  writeFileSync(join(smokeRepoPath, file), "white space\nsame\nold\n")
  git("add", file)
  git("commit", "-m", "seed diff controls")
  writeFileSync(join(smokeRepoPath, file), "white  space\nsame\nnew\n")
  await page.locator(`.list-scroller [title="${file}"]`).waitFor({ state: "visible", timeout: 15000 })
  await page.locator(`.list-scroller [title="${file}"]`).click()
  await expect(page.locator(".diff-container")).toContainText("white  space")
  await setDiffOption(page, "Split")
  await page.locator(".side-by-side-diff-container .modified").waitFor({ state: "visible" })
  await expect(page.locator(".side-by-side-diff-container")).toContainText("new")
  await setDiffOption(page, "Hide Whitespace Changes")
  await expect(page.locator(".side-by-side-diff-container")).toContainText("new")
  await setDiffOption(page, "Unified")
  await page.locator('.diff-container input[placeholder="Find in diff"]').fill("new")
  await expect(page.locator(".diff-container .unified-diff")).toContainText("new")
  await setDiffOption(page, "Hide Whitespace Changes")
  await expect(page.locator(".diff-container")).toContainText("white  space")
})

test("expanded diff discards only the targeted block through the native menu", async ({ mainWindow: page }) => {
  const file = "discard-blocks.txt"
  writeFileSync(join(smokeRepoPath, file), "a\nb\nc\nd\nold1\nmiddle\nold2\nz\n")
  git("add", file)
  git("commit", "-m", "seed discard blocks")
  writeFileSync(join(smokeRepoPath, file), "a\nb\nc\nd\nnew1\nmiddle\nnew2\nz\n")
  await page.locator(`.list-scroller [title="${file}"]`).waitFor({ state: "visible", timeout: 15000 })
  await page.locator(`.list-scroller [title="${file}"]`).click()
  await expect(page.locator(".unified-diff")).toContainText("new1")
  const indexBefore = git("write-tree")
  const context = async (selector: string) =>
    page.evaluate((selector: string) => {
      const target = document.querySelector(selector)!
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: rect.x + 4, clientY: rect.y + 4 })
      )
    }, selector)
  await context(".unified-diff")
  await page.locator('[role="menuitem"]:has-text("Expand whole file")').click()
  await expect(page.locator(".unified-diff")).toContainText("new2")
  await context('.unified-diff label[for="5-after"]')
  await page.locator('[role="menuitem"]:has-text("Discard this hunk")').click()
  await page.locator('[role="alertdialog"]').waitFor({ state: "visible" })
  await page.locator('[role="alertdialog"] button:has-text("OK")').click()
  await expect
    .poll(() => readFileSync(join(smokeRepoPath, file), "utf8"), { timeout: 15000 })
    .toBe("a\nb\nc\nd\nold1\nmiddle\nnew2\nz\n")
  assert.equal(git("write-tree"), indexBefore)
})

test("split diff highlights both revisions and drag-selects a patch range without changing Git's index", async ({
  mainWindow: page
}) => {
  const file = "split-selection.ts"
  writeFileSync(
    join(smokeRepoPath, file),
    "const first = 1\nconst second = 2\nconst unchanged = true\nconst tail = 3\n"
  )
  git("add", file)
  git("commit", "-m", "seed split selection")
  writeFileSync(
    join(smokeRepoPath, file),
    "const first = 10\nconst second = 20\nconst unchanged = true\nconst tail = 30\n"
  )
  const entry = page.locator(`.list-scroller [title="${file}"]`)
  await entry.waitFor({ state: "visible", timeout: 15000 })
  await entry.click()
  await setDiffOption(page, "Split")
  await page.locator(".side-by-side-diff-container .modified").waitFor({ state: "visible" })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelectorAll(
            ".side-by-side-diff-container .before .cm-tok-keyword, .side-by-side-diff-container .before .cm-tok-number"
          ).length
      )
    )
    .toBeGreaterThanOrEqual(1)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelectorAll(
            ".side-by-side-diff-container .after .cm-tok-keyword, .side-by-side-diff-container .after .cm-tok-number"
          ).length
      )
    )
    .toBeGreaterThanOrEqual(1)
  await page.evaluate(() => {
    const rows = document.querySelectorAll(".side-by-side-diff-container .modified")
    const start = rows[0].querySelector(".before .line-number")!
    const end = rows[1].querySelector(".after .line-number")!
    const bounds = end.getBoundingClientRect()
    start.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
    document.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2
      })
    )
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  })
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLInputElement>(".side-by-side-diff-container .modified .line-number input")]
          .map(input => input.checked)
          .join(",")
      )
    )
    .toBe("false,false,false,false,true,true")
  assert.equal(git("diff", "--cached", "--name-only"), "", "UI range selection must not stage files")
  await setDiffOption(page, "Wrap Lines")
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.querySelector(".side-by-side-diff-container .content")!).whiteSpace
    ),
    "pre"
  )
  await setDiffOption(page, "Wrap Lines")
  await setDiffOption(page, "Unified")
})

test("native menu toggles filters, resizes the focused sidebar and confirms force push", async ({
  mainWindow: page
}) => {
  const menu = (payload: string) =>
    page.evaluate(async (payload: string) => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload })
    }, payload)
  // Use the existing compact toolbar's input; its placeholder is localized.
  const before = await page.evaluate(() => document.querySelector(".repository-sidebar")!.getBoundingClientRect().width)
  await page.evaluate(() =>
    document.querySelector<HTMLInputElement>(".changes-list-container input:not([type=checkbox])")!.focus()
  )
  await menu("increase-active-resizable-width")
  await expect
    .poll(() =>
      page.evaluate(() => Math.round(document.querySelector(".repository-sidebar")!.getBoundingClientRect().width))
    )
    .toBe(Math.round(Math.min(before + 5, 600)))
  await menu("decrease-active-resizable-width")
  await menu("toggle-changes-filter")
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector(".changes-list-container > div:first-child input:not([type=checkbox])") === null
      )
    )
    .toBe(true)
  await menu("toggle-changes-filter")
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector(".changes-list-container > div:first-child input:not([type=checkbox])") !== null
      )
    )
    .toBe(true)
  await menu("force-push")
  await page.locator('[role="alertdialog"]').waitFor({ state: "visible" })
  await page.locator('[role="alertdialog"] button:has-text("Cancel")').click()
})

test("worktree menu creates and switches real worktrees", async ({ mainWindow: page }) => {
  const path = `${smokeRepoPath}-ui-worktree`
  // The smoke repository is recreated per run; a sibling left by an earlier run would block `worktree add`.
  rmSync(path, { recursive: true, force: true })
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "menu",
      payload: "create-worktree"
    })
  })
  await page.locator('input[list="worktree-branches"]').waitFor({ state: "visible" })
  await page.locator('input[list="worktree-branches"]').fill("ui-worktree")
  await page.locator('[role="dialog"] input:not([list])').fill(path)
  await page.locator('button:has-text("Create worktree")').click()
  await expect.poll(() => git("worktree", "list").includes(path)).toBe(true)
  const resolvedPath = realpathSync(path)
  const resolvedMainPath = realpathSync(smokeRepoPath)
  await page.locator(`button:has(span[title="${resolvedPath}"])`).click()
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke<AppState>("load_state")).selectedRepository)
    )
    .toBe(resolvedPath)
  const repositories = await page.evaluate(
    async () => (await window.__TAURI_INTERNALS__.invoke<AppState>("load_state")).repositories
  )
  assert.ok(repositories.includes(resolvedPath))
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "menu",
      payload: "show-worktrees"
    })
  })
  await page.locator(`button:has(span[title="${resolvedMainPath}"])`).waitFor({ state: "visible" })
  await page.locator(`button:has(span[title="${resolvedMainPath}"])`).click()
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke<AppState>("load_state")).selectedRepository)
    )
    .toBe(resolvedMainPath)
})

test("push confirmation pulls then retries without reentering the operation lock", async ({ mainWindow: page }) => {
  await page.evaluate(() => {
    const original = window.fetch.bind(window)
    window.__restoreRequestIPC = () => {
      window.fetch = original
    }
    window.__workflowCalls = []
    ;(window as Window).fetch = (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      const command = url.protocol === "ipc:" ? decodeURIComponent(url.pathname.slice(1)) : ""
      if (!["push_with_tags", "pull_output"].includes(command)) return original(input, options)
      const args = JSON.parse(String(options?.body ?? "{}"))
      window.__workflowCalls.push({ command, repo: args.repo })
      const rejected = window.__workflowCalls.length === 1
      return Promise.resolve(
        Response.json(
          rejected
            ? "[rejected] (fetch first)"
            : command === "pull_output"
              ? { exitCode: 0, stdout: "", stderr: "" }
              : null,
          {
            headers: { "Content-Type": "application/json", "Tauri-Response": rejected ? "error" : "ok" }
          }
        )
      )
    }
  })
  try {
    await page.evaluate(async () =>
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "push" })
    )
    await page.locator('[role="alertdialog"]').waitFor({ state: "visible" })
    await expect(page.locator('[role="alertdialog"]')).toContainText("Pull first, then push?")
    await page.locator('[role="alertdialog"] button:has-text("OK")').click()
    await expect.poll(() => page.evaluate(() => window.__workflowCalls.length)).toBe(3)
    assert.deepEqual(
      (await page.evaluate(() => window.__workflowCalls)).map(call => call.command),
      ["push_with_tags", "pull_output", "push_with_tags"]
    )
    await expect.poll(() => page.locator(".branch-button button").isEnabled()).toBe(true)
  } finally {
    await page.evaluate(() => window.__restoreRequestIPC())
  }
})

/** 仓库导航按归属分「我的 / 第三方」页签；冒烟仓库的 origin 是本地路径，自动判定落在第三方。 */
test("repository rail marks uncommitted changes in the selected repository", async ({ mainWindow: page }) => {
  const main = realpathSync(smokeRepoPath)
  const file = join(smokeRepoPath, "rail-indicator.txt")
  await clickRailRepository(page, main)
  const dot = page.locator(`button[title="${main}"] [data-testid="repository-changes"]`)
  try {
    writeFileSync(file, "indicator\n")
    await dot.waitFor({ state: "visible" })
  } finally {
    rmSync(file, { force: true })
  }
  // 前面的用例可能在冒烟仓库里留了改动：删掉临时文件后，圆点跟随仓库的实际状态
  await dot.waitFor({ state: git("status", "--porcelain") ? "visible" : "hidden" })
})

/** 差异设置在齿轮弹层里（Desktop diff-options.tsx）：打开、点选项、再点齿轮关上。 */
async function setDiffOption(page: Page, label: string) {
  const gear = page.locator('button[aria-label="Diff Settings"]')
  await gear.click()
  await page.locator(`[data-slot="popover-content"] label:has-text("${label}")`).click()
  await gear.click()
  await page.locator('[data-slot="popover-content"]').waitFor({ state: "hidden" })
}

async function clickRailRepository(page: Page, path: string) {
  const button = page.locator(`button[title="${path}"]`)
  if (!(await button.isVisible())) {
    await page.locator('[data-slot="tabs-trigger"]:has-text("Third-party")').click()
    await button.waitFor({ state: "visible" })
  }
  await button.click()
}

test("finishing an old repository operation cannot replace the newly selected repository status", async ({
  mainWindow: page
}) => {
  const main = realpathSync(smokeRepoPath)
  const other = realpathSync(`${smokeRepoPath}-ui-worktree`)
  await page.evaluate(() => {
    const original = window.fetch.bind(window)
    window.__restoreRequestIPC = () => {
      window.fetch = original
    }
    window.__workflowCalls = []
    ;(window as Window).fetch = (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      const command = url.protocol === "ipc:" ? decodeURIComponent(url.pathname.slice(1)) : ""
      if (!["push_with_tags", "repo_status"].includes(command)) return original(input, options)
      const args = JSON.parse(String(options?.body ?? "{}"))
      window.__workflowCalls.push({ command, repo: args.repo })
      if (command === "repo_status") return original(input, options)
      return new Promise(resolve => {
        window.__releasePush = () =>
          resolve(
            new Response("null", {
              headers: { "Content-Type": "application/json", "Tauri-Response": "ok" }
            })
          )
      })
    }
  })
  try {
    await page.evaluate(async () =>
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "push" })
    )
    await expect
      .poll(() => page.evaluate(() => window.__workflowCalls.some(call => call.command === "push_with_tags")))
      .toBe(true)
    await clickRailRepository(page, other)
    await expect(page.locator(".branch-button")).toContainText("ui-worktree")
    const oldRequests = await page.evaluate(
      path => window.__workflowCalls.filter(call => call.command === "repo_status" && call.repo === path).length,
      main
    )
    await page.evaluate(() => window.__releasePush())
    await expect.poll(() => page.locator(".branch-button button").isEnabled()).toBe(true)
    await expect(page.locator(".branch-button")).toContainText("ui-worktree")
    assert.equal(
      await page.evaluate(
        path => window.__workflowCalls.filter(call => call.command === "repo_status" && call.repo === path).length,
        main
      ),
      oldRequests
    )
  } finally {
    await page.evaluate(() => {
      window.__releasePush?.()
      window.__restoreRequestIPC()
    })
    await clickRailRepository(page, main)
    await expect(page.locator(".branch-button")).toContainText("remote-feature")
  }
})

test("failed amendment keeps the draft and excludes concurrent push", async ({ mainWindow: page }) => {
  const head = git("rev-parse", "HEAD")
  await page.locator('.changes-list-container button[aria-label="Filter"]').click()
  await page.locator('[role="menuitem"]:has-text("Amend last commit")').click()
  await page.locator('button.commit-button:has-text("Amend")').waitFor({ state: "visible" })
  await page.locator(".summary-field input").fill("Preserve rejected amendment")
  await page.evaluate(() => {
    const original = window.fetch.bind(window)
    window.__restoreRequestIPC = () => {
      window.fetch = original
    }
    window.__workflowCalls = []
    ;(window as Window).fetch = (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      const command = url.protocol === "ipc:" ? decodeURIComponent(url.pathname.slice(1)) : ""
      if (!["amend_commit", "push_with_tags"].includes(command)) return original(input, options)
      const args = JSON.parse(String(options?.body ?? "{}"))
      window.__workflowCalls.push({ command, repo: args.repo })
      if (command === "push_with_tags") throw new Error("Push overlapped amendment")
      return new Promise(resolve => {
        window.__releasePush = () =>
          resolve(
            Response.json("pre-commit hook rejected amendment", {
              headers: { "Content-Type": "application/json", "Tauri-Response": "error" }
            })
          )
      })
    }
  })
  try {
    await page.locator("button.commit-button").click()
    await expect.poll(() => page.evaluate(() => window.__workflowCalls.length)).toBe(1)
    await page.evaluate(async () =>
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "push" })
    )
    await page.evaluate(() => window.__releasePush())
    await expect(page.locator("body")).toContainText("pre-commit hook rejected amendment")
    await expect.poll(() => page.locator("button.commit-button").isEnabled()).toBe(true)
    await expect(page.locator("button.commit-button")).toContainText("Amend")
    assert.equal(await page.locator(".summary-field input").inputValue(), "Preserve rejected amendment")
    assert.equal(git("rev-parse", "HEAD"), head)
    assert.deepEqual(
      (await page.evaluate(() => window.__workflowCalls)).map(call => call.command),
      ["amend_commit"]
    )
  } catch (error) {
    console.error("Amendment UI at failure:", await page.evaluate(() => document.body.innerText))
    throw error
  } finally {
    await page.evaluate(() => {
      window.__releasePush?.()
      window.__restoreRequestIPC()
    })
    await page.locator('[role="button"]:has-text("Stop amending")').click()
  }
})

test("fork pull requests list the parent and check out the source through the native UI", async ({
  mainWindow: page
}) => {
  const previousBranch = git("branch", "--show-current")
  const previousHead = git("rev-parse", "HEAD")
  const previousOrigin = git("remote", "get-url", "origin")
  const fork = `${smokeRepoPath}-pr-fork`
  rmSync(fork, { recursive: true, force: true })
  execFileSync("git", ["clone", "-q", smokeRepoPath, fork])
  writeFileSync(join(fork, "fork-pr.txt"), "fork pull request\n")
  execFileSync("git", ["-C", fork, "add", "."])
  execFileSync("git", ["-C", fork, "-c", "commit.gpgsign=false", "commit", "-m", "fork pull request"])
  const forkHead = execFileSync("git", ["-C", fork, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  git("remote", "set-url", "origin", "https://fork.example/me/fork.git")
  git("remote", "add", "github-desktop-alice", "https://fork.example/alice/fork.git")
  git("fetch", fork, "HEAD:refs/remotes/github-desktop-alice/main")
  await page.evaluate(() => {
    const original = window.fetch.bind(window)
    const reply = (value: unknown) =>
      Promise.resolve(Response.json(value, { headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } }))
    window.__restoreRequestIPC = () => {
      ;(window as Window).fetch = original
    }
    window.__requestTargets = []
    ;(window as Window).fetch = (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      const command = url.protocol === "ipc:" ? decodeURIComponent(url.pathname.slice(1)) : ""
      if (!["pull_request_repository", "pull_requests", "pull_request_source"].includes(command))
        return original(input, options)
      const args = command ? JSON.parse(String(options?.body ?? "{}")) : {}
      if (command === "pull_request_repository") return reply({ host: "fork.example", owner: "org", name: "upstream" })
      if (command === "pull_requests") {
        window.__requestTargets.push(args)
        return reply([
          {
            number: 17,
            headSha: "",
            title: "Fork PR fixture",
            author: "alice",
            head: "main",
            base: "main",
            draft: false,
            url: "https://fork.example/org/upstream/pull/17",
            checks: null
          }
        ])
      }
      if (command === "pull_request_source")
        return reply({
          number: 17,
          owner: "alice",
          cloneUrl: "https://fork.example/alice/fork.git",
          branch: "main",
          kind: "github",
          target: { host: "fork.example", owner: "org", name: "upstream" }
        })
      return original(input, options)
    }
  })
  try {
    // Refresh metadata through the same path used after editing a remote in preferences.
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "menu",
        payload: "preferences"
      })
    })
    await page.locator('[role="dialog"]').waitFor({ state: "visible" })
    await page.keyboard.press("Escape")
    await page.locator('[role="dialog"]').waitFor({ state: "hidden" })
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "menu",
        payload: "show-prs"
      })
    })
    // Desktop：PR 列表在分支下拉的「Pull Requests」页签里，点一行就检出
    await page.locator('.pull-request-item:has-text("Fork PR fixture")').waitFor({ state: "visible" })
    const targets = await page.evaluate(() => window.__requestTargets)
    assert.ok(targets.length > 0)
    assert.ok(targets.every(r => r.owner === "org" && r.name === "upstream"))
    // Desktop _checkoutBranch：有本地改动时先问去向（StashAndSwitchBranch）；带着改动过去
    writeFileSync(join(smokeRepoPath, "pr-switch-local.txt"), "carried to the PR branch\n")
    await page.locator('.pull-request-item:has-text("Fork PR fixture")').click()
    await page.locator('#stash-changes .title:has-text("Bring my changes")').click()
    await page.locator('#stash-changes button:has-text("Switch Branch")').click()
    await expect.poll(() => git("branch", "--show-current")).toBe("pr/17")
    assert.equal(readFileSync(join(smokeRepoPath, "pr-switch-local.txt"), "utf8"), "carried to the PR branch\n")
    rmSync(join(smokeRepoPath, "pr-switch-local.txt"))
    assert.equal(git("rev-parse", "HEAD"), forkHead)
    assert.equal(git("rev-parse", previousBranch), previousHead)
    assert.equal(git("rev-parse", "--abbrev-ref", "@{upstream}"), "github-desktop-alice/main")
    git("checkout", previousBranch)
    writeFileSync(join(smokeRepoPath, "drag-to-request.txt"), "native drag\n")
    git("add", "drag-to-request.txt")
    git("-c", "commit.gpgsign=false", "commit", "-m", "Native drag to request")
    const sourceHead = git("rev-parse", "HEAD")
    writeFileSync(join(smokeRepoPath, "drag-local-edit.txt"), "keep local edits\n")
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "show-history" })
    })
    await page.locator('[draggable="true"]:has-text("Native drag to request")').waitFor({ state: "visible" })
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[draggable="true"]')].find(row =>
        row.textContent?.includes("Native drag to request")
      )
      if (!row) throw new Error("Missing draggable history row")
      window.__commitDrag = new DataTransfer()
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__commitDrag }))
      // Desktop：拖着提交经过分支按钮展开下拉，经过「Pull Requests」页签切过去
      const button = document.querySelector(".branch-button")
      if (!button) throw new Error("Missing branch button")
      button.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: window.__commitDrag }))
    })
    await page.locator("#pull-requests-tab").waitFor({ state: "visible" })
    await page.evaluate(() => {
      document
        .querySelector("#pull-requests-tab")!
        .dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: window.__commitDrag }))
    })
    await page.locator('.pull-request-item:has-text("Fork PR fixture")').waitFor({ state: "visible" })
    await page.evaluate(() => {
      const row = [...document.querySelectorAll(".pull-request-item")].find(row =>
        row.textContent?.includes("Fork PR fixture")
      )
      if (!row) throw new Error("Missing request drop target")
      row.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__commitDrag })
      )
      row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__commitDrag }))
    })
    await page.locator('[role="alertdialog"]').waitFor({ state: "visible" })
    await expect(page.locator('[role="alertdialog"]')).toContainText("Stash them first?")
    await page.locator('[role="alertdialog"] button:has-text("OK")').click()
    await page.locator('[role="alertdialog"]').waitFor({ state: "hidden" })
    await expect.poll(() => git("branch", "--show-current")).toBe("pr/17")
    await expect.poll(() => git("log", "-1", "--format=%s")).toBe("Native drag to request")
    assert.equal(git("show", "HEAD:drag-to-request.txt"), "native drag")
    assert.equal(git("rev-parse", previousBranch), sourceHead)
    // Desktop stages untracked files before stashing, so they live in the stash
    // tree itself, not a third parent from Git's --include-untracked mode.
    assert.equal(git("show", "stash@{0}:drag-local-edit.txt"), "keep local edits")
  } finally {
    await page.evaluate(() => window.__restoreRequestIPC())
    git("checkout", previousBranch)
    git("remote", "set-url", "origin", previousOrigin)
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "menu",
        payload: "show-changes"
      })
    })
  }
})

test("multi-file discard uses one confirmation and preserves unselected files", async ({ mainWindow: page }) => {
  const names = ["batch-a.txt", "batch-b.txt", "batch-c.txt"]
  for (const name of names) writeFileSync(join(smokeRepoPath, name), `keep ${name}\n`)
  await page.locator('.list-scroller [title="batch-a.txt"]').waitFor({ state: "visible", timeout: 15000 })
  await page.locator('.list-scroller [title="batch-a.txt"]').click()
  // Hasgard focuses its exact click target; a path span is not focusable.
  // Target the same focusable List row that receives Desktop's menu events.
  await page.locator('.list-scroller [role="listitem"]:has([title="batch-a.txt"])').click()
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.list-scroller [role="listitem"]')), true)
  const visibleRows = await page.evaluate(() => document.querySelectorAll('.list-scroller [role="listitem"]').length)
  assert.ok(visibleRows >= 3)
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "select-all" })
  })
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelectorAll('.list-scroller [role="listitem"][aria-current="true"]').length)
    )
    .toBe(visibleRows)
  await page.locator('.list-scroller [title="batch-a.txt"]').click()
  // Hasgard's click API has no modifiers; dispatch the native DOM mouse sequence.
  await page.evaluate(() => {
    const row = document.querySelector('.list-scroller [title="batch-c.txt"]')!
    for (const type of ["mousedown", "mouseup", "click"])
      row.dispatchEvent(new MouseEvent(type, { bubbles: true, metaKey: true, button: 0 }))
  })
  await expect(page.locator("body")).toContainText("2 files selected")
  const indexBefore = git("write-tree")
  await page.evaluate(() => {
    const row = document.querySelector('.list-scroller [title="batch-a.txt"]')!
    const rect = row.getBoundingClientRect()
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: rect.x + 4, clientY: rect.y + 4 })
    )
  })
  // Desktop getDiscardChangesMenuItemLabel：多选时是「Discard N Selected Changes…」
  await page.locator('[role="menuitem"]:has-text("Discard 2 Selected Changes")').click()
  await expect(page.locator('[role="alertdialog"]')).toContainText("batch-a.txt")
  await expect(page.locator('[role="alertdialog"]')).toContainText("batch-c.txt")
  await page.locator('[role="alertdialog"] button:has-text("Discard changes")').click()
  await expect.poll(() => existsSync(join(smokeRepoPath, "batch-a.txt"))).toBe(false)
  await expect.poll(() => existsSync(join(smokeRepoPath, "batch-c.txt"))).toBe(false)
  assert.equal(readFileSync(join(smokeRepoPath, "batch-b.txt"), "utf8"), "keep batch-b.txt\n")
  // Desktop discardChanges 先挪废纸篓、再 reset + checkout-index：文件没了时应用可能还拿着 index.lock，
  // 等这一步做完再比索引，不和它抢锁
  await expect
    .poll(() => {
      try {
        return git("write-tree")
      } catch {
        return "index busy"
      }
    })
    .toBe(indexBefore)
})

test("hooks environment proxies a failing pre-commit hook and continues after ignoring it", async ({
  mainWindow: page
}) => {
  const head = git("rev-parse", "HEAD")
  const hook = join(smokeRepoPath, ".git", "hooks", "pre-commit")
  const marker = join(smokeRepoPath, ".git", "hook-env-marker")
  writeFileSync(
    hook,
    `#!/bin/sh\necho "desktop=$GITHUB_DESKTOP" > '${marker}'\necho "rejected by hook" >&2\nexit 1\n`,
    {
      mode: 0o755
    }
  )
  writeFileSync(join(smokeRepoPath, "hooks-env.txt"), "hooks env\n")
  // Desktop lib/hooks/config.ts：Preferences > Git > Hooks 的开关存在 localStorage
  await page.evaluate(() => localStorage.setItem("git-hooks-env-enabled", "1"))
  try {
    await page.locator('.list-scroller [title="hooks-env.txt"]').waitFor({ state: "visible", timeout: 15000 })
    await page.locator(".summary-field input").fill("Commit through the hooks proxy")
    await page.locator("button.commit-button").click()
    const dialog = page.locator("#hook-failed-dialog")
    await expect(dialog).toContainText("The pre-commit hook failed. What would you like to do?", { timeout: 30000 })
    await expect(dialog).toContainText("rejected by hook")
    await expect(page.locator(".commit-progress")).toContainText("pre-commit hook running…")
    assert.equal(readFileSync(marker, "utf8"), "desktop=1\n")
    await dialog.locator('button:has-text("Ignore and Continue")').click()
    await expect.poll(() => git("log", "-1", "--format=%s")).toBe("Commit through the hooks proxy")
    assert.equal(git("rev-parse", "HEAD~1"), head)
  } catch (error) {
    console.error("Hooks UI at failure:", await page.evaluate(() => document.body.innerText))
    console.error(
      "Hooks probe:",
      await page.evaluate(async (repo: string) => {
        const started = Date.now()
        const hooks = await window.__TAURI_INTERNALS__.invoke("repo_hooks", { repo, filter: ["pre-commit"] })
        return { hooks, enabled: localStorage.getItem("git-hooks-env-enabled"), ms: Date.now() - started }
      }, smokeRepoPath)
    )
    throw error
  } finally {
    await page.evaluate(() => localStorage.removeItem("git-hooks-env-enabled"))
    rmSync(hook, { force: true })
    rmSync(marker, { force: true })
    if (git("rev-parse", "HEAD") !== head) git("reset", "-q", head)
    rmSync(join(smokeRepoPath, "hooks-env.txt"), { force: true })
  }
})

test("About exposes the author's GitHub profile", async ({ mainWindow: page }) => {
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-event", payload: ["show-about"] })
  })
  const link = page.locator('a[href="https://github.com/nyssance"]')
  await link.waitFor({ state: "visible" })
  await expect(link).toContainText("@nyssance")
  // Desktop guards dismissal for 250ms after opening to avoid accidental closes.
  await expect
    .poll(async () => {
      await page.keyboard.press("Escape")
      return link.isVisible()
    })
    .toBe(false)
})

test("saved Chinese language applies to welcome and Git identity before onboarding", async ({ mainWindow: page }) => {
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "preferences" })
  })
  await page.locator('[role="tab"]:has-text("Advanced")').click()
  await page.locator('button:has-text("简体中文")').click()
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        return (await window.__TAURI_INTERNALS__.invoke<AppState>("load_state")).language
      })
    )
    .toBe("zh-CN")
  // 全局 git 已有 name 和 email 时，跳过登录会直接结束欢迎流程（不再单独问 Git 身份）；
  // 这里要看到「配置 Git」那一步，先把前面用例写进去的全局身份清掉。
  for (const key of ["user.name", "user.email"]) {
    try {
      execFileSync("git", ["config", "--global", "--unset", key], { stdio: "ignore" })
    } catch {
      // 本来就没设
    }
  }
  await page.evaluate(async () => {
    localStorage.removeItem("has-shown-welcome-flow")
    // 完成标记存在 Rust 侧 state.json（welcomed），要重进欢迎流程得先清掉
    const state = await window.__TAURI_INTERNALS__.invoke<AppState>("load_state")
    await window.__TAURI_INTERNALS__.invoke("save_state", { state: { ...state, welcomed: false } })
    location.reload()
  })
  await expect(page.locator(".welcome-title")).toContainText("欢迎使用 GitCub", { timeout: 15000 })
  // Layout is covered by stories/welcome.stories.tsx; this test verifies native language persistence.
  await page.locator("a.skip-button").click()
  await expect(page.locator(".welcome-title")).toContainText("配置 Git")
  await page.locator('input[placeholder="你的姓名"]').waitFor({ state: "visible" })
  await page.locator('button:has-text("完成")').waitFor({ state: "visible" })
})
