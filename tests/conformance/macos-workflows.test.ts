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
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
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
  // 照 Desktop 账户页签：每个平台一节，标题是平台名
  await expect(page.locator('[role="dialog"] legend:has-text("GitHub.com")')).toContainText("GitHub.com")
  await expect(page.locator('[role="dialog"] legend:has-text("GitLab.com")')).toContainText("GitLab.com")
  // 点「取消」，不走原生按键注入：第一个用例抢不到焦点时 Esc 会超时，弹窗留着连带后面全部失败
  await page.locator('[role="dialog"] button:has-text("Cancel")').click()
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
  // Desktop：⌘F 才弹出搜索框，回车开始搜，结果经 aria-live 播报
  await page.keyboard.press("Meta+f")
  // 搜索框挂载后才自动聚焦；先点一下确保回车落在输入框上
  const search = page.locator(".diff-search input")
  await search.click()
  await search.fill("new")
  await page.keyboard.press("Enter")
  await expect(page.locator(".diff-container")).toContainText('Result 1 of 1 for "new"')
  await page.keyboard.press("Escape")
  await page.locator(".diff-search").waitFor({ state: "hidden" })
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

// 原 .storybook/desktop-layout.spec.ts 的比对搬到真实应用：把生产 DOM 放进只带 Desktop 原版样式表
// （tests/conformance/fixtures/desktop-ui-styles，source.json 记着上游哈希）的 iframe，逐元素比尺寸和配色。
// 比的是 CSS 一致，不是 DOM 一致。
// run.ts 把测试构建到 node_modules/.gitcub-conformance-*/ 下执行，往上两级是仓库根目录
const desktopStyles = join(import.meta.dirname, "../../tests/conformance/fixtures/desktop-ui-styles")
const readDesktopStyle = (path: string) => readFileSync(join(desktopStyles, path), "utf8")

test("Desktop stylesheet snapshots retain upstream hashes", async () => {
  const source: { files: Record<string, string> } = JSON.parse(readDesktopStyle("source.json"))
  for (const [path, hash] of Object.entries(source.files))
    assert.equal(
      createHash("sha256")
        .update(readDesktopStyle(basename(path)))
        .digest("hex"),
      hash,
      path
    )
})

test("diff geometry and colors match the Desktop stylesheet in both themes and layouts", async ({
  mainWindow: page
}) => {
  const variables = readDesktopStyle("_variables.scss")
  const emojiFonts = variables.match(/\$emoji_fallback_fonts:\s*([^;]+);/)![1]
  const themes: Record<string, string> = JSON.parse(readDesktopStyle("compiled-themes.json"))
  const referenceCss = `
    html { box-sizing: border-box; }
    *, *::before, *::after { box-sizing: inherit; }
    body { margin: 0; }
    :root {
      --spacing: ${variables.match(/--spacing:\s*([^;]+);/)![1]}; --spacing-half: calc(var(--spacing) / 2);
      --border-radius: ${variables.match(/--border-radius:\s*([^;]+);/)![1]}; --font-size-sm: 11px;
      --font-family-monospace: ${variables
        .match(/--font-family-monospace:\s*([^;]+);/)![1]
        .replace("#{$emoji_fallback_fonts}", emojiFonts)};
      --diff-border-color: black;
    }
    ${readDesktopStyle("_app.scss").match(/\.sr-only\s*\{[^}]+\}/)![0]}
    ${readDesktopStyle("_octicons.scss")}
    ${readDesktopStyle("_side-by-side-diff.scss").replaceAll(/\/\/[^\n]*/g, "")}
    ${readDesktopStyle("_diff.scss")
      .match(/\.cm-diff-(?:delete|add)-inner\s*\{[^}]+\}/g)!
      .slice(0, 2)
      .join("\n")}
  `
  // 纯文本：参照样式表只有 diff 本身，没有语法高亮的配色
  const file = "desktop-style.txt"
  writeFileSync(join(smokeRepoPath, file), "first line\nsecond line\nthird line\nfourth line\n")
  git("add", file)
  git("commit", "-m", "seed desktop style diff")
  writeFileSync(join(smokeRepoPath, file), "first line\nsecond row\nthird line\nfourth line\nfifth line\n")
  const entry = page.locator(`.list-scroller [title="${file}"]`)
  await entry.waitFor({ state: "visible", timeout: 15000 })
  await entry.click()
  try {
    for (const layout of ["Unified", "Split"]) {
      await setDiffOption(page, layout)
      await page.locator(".side-by-side-diff-container .line-number").waitFor({ state: "visible" })
      for (const theme of ["light", "dark"]) {
        const { actual, expected } = await page.evaluate(
          async ({ css, dark }) => {
            document.documentElement.classList.toggle("dark", dark)
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            const selector =
              ".line-number, .line-number > label, .line-number > label > span, .line-number-check, .hunk-handle, .focus-handle, .hunk-expansion-handle, .octicon, .cm-diff-add-inner, .cm-diff-delete-inner"
            const measure = (root: Element) =>
              [...root.querySelectorAll(selector)].map(element => {
                const style = getComputedStyle(element)
                const rect = element.getBoundingClientRect()
                return {
                  className: String((element as HTMLElement).className),
                  width: rect.width,
                  height: rect.height,
                  boxSizing: style.boxSizing,
                  display: style.display,
                  flexShrink: style.flexShrink,
                  padding: style.padding,
                  borderRadius: style.borderRadius,
                  borderWidth: style.borderWidth,
                  borderColor: style.borderColor,
                  backgroundColor: style.backgroundColor,
                  color: style.color,
                  fontSize: style.fontSize,
                  fontFamily: style.fontFamily
                }
              })
            const root = document.querySelector(".side-by-side-diff-container")!
            const size = root.getBoundingClientRect()
            const frame = document.createElement("iframe")
            frame.style.cssText = `position:fixed;left:-10000px;top:0;border:0;width:${size.width}px;height:${size.height}px`
            frame.srcdoc = `<style>${css}</style><main style="display:flex;flex-direction:column;width:${size.width}px;height:${size.height}px">${root.outerHTML}</main>`
            await new Promise(resolve => {
              frame.onload = resolve
              document.body.append(frame)
            })
            const expected = measure(frame.contentDocument!.querySelector(".side-by-side-diff-container")!)
            frame.remove()
            return { actual: measure(root), expected }
          },
          {
            css: `${referenceCss}\n:root { ${themes[":root"]} ${theme === "dark" ? themes["body.theme-dark"] : ""} }`,
            dark: theme === "dark"
          }
        )
        // 有登记的可访问性差异：深色下绿色词高亮上的字用白色，对比度才够 4.5:1，其余值必须一致
        for (const element of expected)
          if (theme === "dark" && element.className === "cm-diff-add-inner") {
            assert.equal(element.backgroundColor, "rgb(34, 134, 58)")
            assert.equal(element.color, "rgb(246, 248, 250)")
            element.color = "rgb(255, 255, 255)"
            element.borderColor = "rgb(255, 255, 255)"
          }
        assert.ok(actual.length > 0, `${layout} / ${theme}: no diff elements measured`)
        assert.deepEqual(actual, expected, `${layout} / ${theme}`)
      }
    }
  } finally {
    await page.evaluate(() => document.documentElement.classList.remove("dark"))
    await setDiffOption(page, "Unified")
    git("checkout", "--", file)
  }
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

// Desktop preferences.tsx：页签里的改动只在「保存」时写回（onSave），「取消」丢弃；
// 主题选了立即预览，取消时还原（onCancel → onSelectedThemeChanged(initiallySelectedTheme)）
test("settings apply only on Save, Cancel discards them and reverts the theme preview", async ({
  mainWindow: page
}) => {
  const dialog = page.locator('[role="dialog"]')
  const openSettings = async (tab: string) => {
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "preferences" })
    })
    await dialog.waitFor({ state: "visible" })
    await dialog.locator(`[role="tab"]:has-text("${tab}")`).click()
  }
  const forcePushPrompt = () => page.evaluate(() => localStorage.getItem("confirmForcePush") !== "0")
  const dark = () => page.evaluate(() => document.documentElement.classList.contains("dark"))
  const promptBefore = await forcePushPrompt()
  const darkBefore = await dark()

  await openSettings("Appearance")
  await dialog.locator(`button:has-text("${darkBefore ? "Light" : "Dark"}")`).click()
  await expect.poll(dark).toBe(!darkBefore)
  await dialog.locator('[role="tab"]:has-text("Prompts")').click()
  await dialog.locator('label:has-text("Force pushing")').click()
  await dialog.locator('button:has-text("Cancel")').click()
  await dialog.waitFor({ state: "hidden" })
  await expect.poll(dark).toBe(darkBefore)
  assert.equal(await forcePushPrompt(), promptBefore, "Cancel must not write the prompt setting")

  await openSettings("Prompts")
  await dialog.locator('label:has-text("Force pushing")').click()
  assert.equal(await forcePushPrompt(), promptBefore, "the setting is written only on Save")
  await dialog.locator('button:has-text("Save")').click()
  await dialog.waitFor({ state: "hidden" })
  assert.equal(await forcePushPrompt(), !promptBefore)

  await openSettings("Prompts")
  await dialog.locator('label:has-text("Force pushing")').click()
  await dialog.locator('button:has-text("Save")').click()
  await dialog.waitFor({ state: "hidden" })
  assert.equal(await forcePushPrompt(), promptBefore)
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

/** Desktop：修订从历史页 HEAD 那条提交的右键菜单「Amend Commit…」进入；已推送时先过 WarnForcePush，然后回到 Changes 页 */
async function startAmendingFromHistory(page: Page) {
  const summary = git("log", "-1", "--format=%s")
  const branch = git("branch", "--show-current")
  await page.locator('[role="tab"]:has-text("History")').click()
  await page.locator(`.desktop-list [title="${summary}"]`).first().waitFor({ state: "visible", timeout: 15000 })
  // 提交图列出全部分支，别的分支上可能有同名提交：找带当前分支标记的那一行
  await page.evaluate(
    ([summary, branch]: [string, string]) => {
      const rows = [...document.querySelectorAll(".desktop-list .desktop-list-row")]
      const row = rows.find(
        row =>
          row.querySelector(`[title="${CSS.escape(summary)}"]`) &&
          [...row.querySelectorAll("*")].some(
            element => element.children.length === 0 && element.textContent === branch
          )
      )!
      const rect = row.getBoundingClientRect()
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: rect.x + 4, clientY: rect.y + 4 })
      )
    },
    [summary, branch] as [string, string]
  )
  await page.locator('[role="menuitem"]:has-text("Amend Commit…")').click()
  const amend = page.locator('button.commit-button:has-text("Amend")')
  const warning = page.locator("#warn-force-push")
  await expect.poll(async () => (await amend.isVisible()) || (await warning.isVisible()), { timeout: 15000 }).toBe(true)
  if (await warning.isVisible()) await page.locator('#warn-force-push button:has-text("Begin Amend")').click()
  await amend.waitFor({ state: "visible" })
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
  await startAmendingFromHistory(page)
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
    // Desktop performFailableOperation → AppError 对话框
    await expect(page.locator("#app-error")).toContainText("pre-commit hook rejected amendment")
    await page.locator('#app-error button:has-text("Close")').click()
    await page.locator("#app-error").waitFor({ state: "hidden" })
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
    // 点「取消」关闭，不走原生按键注入（Esc 偶发注入超时）
    await page.locator('[role="dialog"] button:has-text("Cancel")').click()
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
  } catch (error) {
    console.error("Fork pull request UI at failure:", await page.evaluate(() => document.body.innerText))
    console.error("Fork pull request Git at failure:", git("status", "--short", "--branch"))
    throw error
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

test("aborting a failing commit-msg hook while amending keeps the commit and reports no error", async ({
  mainWindow: page
}) => {
  const head = git("rev-parse", "HEAD")
  const hook = join(smokeRepoPath, ".git", "hooks", "commit-msg")
  writeFileSync(hook, '#!/bin/sh\necho "amend rejected by hook" >&2\nexit 1\n', { mode: 0o755 })
  await page.evaluate(() => localStorage.setItem("git-hooks-env-enabled", "1"))
  try {
    await startAmendingFromHistory(page)
    await page.locator(".summary-field input").fill("Amend through the hooks proxy")
    await page.locator("button.commit-button").click()
    const dialog = page.locator("#hook-failed-dialog")
    await expect(dialog).toContainText("The commit-msg hook failed. What would you like to do?", { timeout: 30000 })
    await expect(dialog).toContainText("amend rejected by hook")
    // Desktop Dialog ignores dismissal during its first 250ms; Abort is a dismissal
    await new Promise(resolve => setTimeout(resolve, 300))
    await dialog.locator('button:has-text("Abort")').click()
    await expect.poll(() => page.locator("button.commit-button").isEnabled()).toBe(true)
    assert.equal(git("rev-parse", "HEAD"), head)
    await expect(page.locator("button.commit-button")).toContainText("Amend")
    assert.equal(await page.evaluate(() => document.body.innerText.includes("amend rejected by hook")), false)
  } catch (error) {
    console.error("Amend hooks UI at failure:", await page.evaluate(() => document.body.innerText))
    throw error
  } finally {
    await page.evaluate(() => localStorage.removeItem("git-hooks-env-enabled"))
    rmSync(hook, { force: true })
    await page.locator('[role="button"]:has-text("Stop amending")').click()
  }
})

test("a failing pre-push hook goes through the proxy and aborting stops the push quietly", async ({
  mainWindow: page
}) => {
  const tracking = git("rev-parse", "refs/remotes/origin/remote-feature")
  const hook = join(smokeRepoPath, ".git", "hooks", "pre-push")
  const marker = join(smokeRepoPath, ".git", "pre-push-marker")
  writeFileSync(
    hook,
    `#!/bin/sh\n{ echo "remote=$1"; cat; } > '${marker}'\necho "push rejected by hook" >&2\nexit 1\n`,
    {
      mode: 0o755
    }
  )
  await page.evaluate(() => localStorage.setItem("git-hooks-env-enabled", "1"))
  try {
    await page.evaluate(async () =>
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "push" })
    )
    const dialog = page.locator("#hook-failed-dialog")
    await expect(dialog).toContainText("The pre-push hook failed. What would you like to do?", { timeout: 30000 })
    await expect(dialog).toContainText("push rejected by hook")
    // The smoke origin has diverged, so git rejects the update before pre-push and leaves its stdin empty;
    // stdin forwarding is covered end to end by hooks::proxy::tests::pre_push_through_git_gets_refs_on_stdin
    assert.match(readFileSync(marker, "utf8"), /^remote=origin\n/)
    // Desktop Dialog ignores dismissal during its first 250ms; Abort is a dismissal
    await new Promise(resolve => setTimeout(resolve, 300))
    await dialog.locator('button:has-text("Abort")').click()
    await expect.poll(() => page.locator(".branch-button button").isEnabled()).toBe(true)
    assert.equal(git("rev-parse", "refs/remotes/origin/remote-feature"), tracking)
    assert.equal(await page.evaluate(() => document.body.innerText.includes("push rejected by hook")), false)
  } catch (error) {
    console.error("Push hooks UI at failure:", await page.evaluate(() => document.body.innerText))
    throw error
  } finally {
    await page.evaluate(() => localStorage.removeItem("git-hooks-env-enabled"))
    rmSync(hook, { force: true })
    rmSync(marker, { force: true })
  }
})

/** A side branch off HEAD~1 so merging it into the current branch needs a real merge commit */
function divergedBranch(name: string) {
  const head = git("rev-parse", "HEAD")
  const side = git("commit-tree", "HEAD~1^{tree}", "-p", "HEAD~1", "-m", `${name} side commit`)
  git("update-ref", `refs/heads/${name}`, side)
  return { head, side }
}

async function ignoreFailingPreMergeCommit(page: Page, run: () => Promise<void>) {
  const hook = join(smokeRepoPath, ".git", "hooks", "pre-merge-commit")
  writeFileSync(hook, '#!/bin/sh\necho "merge rejected by hook" >&2\nexit 1\n', { mode: 0o755 })
  await page.evaluate(() => localStorage.setItem("git-hooks-env-enabled", "1"))
  try {
    await run()
    const dialog = page.locator("#hook-failed-dialog")
    await expect(dialog).toContainText("The pre-merge-commit hook failed. What would you like to do?", {
      timeout: 30000
    })
    await expect(dialog).toContainText("merge rejected by hook")
    await dialog.locator('button:has-text("Ignore and Continue")').click()
  } catch (error) {
    console.error("Merge hooks UI at failure:", await page.evaluate(() => document.body.innerText))
    throw error
  } finally {
    await page.evaluate(() => localStorage.removeItem("git-hooks-env-enabled"))
    rmSync(hook, { force: true })
  }
}

test("merging a branch asks about a failing pre-merge-commit hook and ignoring it completes the merge", async ({
  mainWindow: page
}) => {
  const { head, side } = divergedBranch("hooks-merge-source")
  try {
    await ignoreFailingPreMergeCommit(page, async () => {
      await page.evaluate(async () =>
        window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "merge-branch" })
      )
      const source = page.locator('.branches-list-item .name:has-text("hooks-merge-source")')
      await source.waitFor({ state: "visible", timeout: 15000 })
      await source.click()
    })
    await expect.poll(() => git("log", "-1", "--format=%P")).toBe(`${head} ${side}`)
  } finally {
    if (git("rev-parse", "HEAD") !== head) git("reset", "-q", "--keep", head)
    git("branch", "-D", "hooks-merge-source")
  }
})

test("pulling asks about a failing pre-merge-commit hook and ignoring it completes the merge", async ({
  mainWindow: page
}) => {
  // The smoke origin is the repository itself; pointing the upstream at a diverged branch makes the pull merge
  const { head, side } = divergedBranch("hooks-pull-source")
  const upstream = git("config", "branch.remote-feature.merge")
  git("config", "branch.remote-feature.merge", "refs/heads/hooks-pull-source")
  try {
    await ignoreFailingPreMergeCommit(page, () =>
      page.evaluate(async () =>
        window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "pull" })
      )
    )
    await expect.poll(() => git("log", "-1", "--format=%P")).toBe(`${head} ${side}`)
  } finally {
    git("config", "branch.remote-feature.merge", upstream)
    if (git("rev-parse", "HEAD") !== head) git("reset", "-q", "--keep", head)
    git("branch", "-D", "hooks-pull-source")
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

test("history context menu checks out a commit and creates a branch from it", async ({ mainWindow: page }) => {
  const branch = git("branch", "--show-current")
  const head = git("rev-parse", "HEAD")
  const stashed = git("status", "--porcelain") !== ""
  if (stashed) git("stash", "push", "-u", "-q")
  git("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "checkout probe base")
  const base = git("rev-parse", "HEAD")
  git("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "checkout probe tip")
  const tip = git("rev-parse", "HEAD")
  const openMenu = async (summary: string) => {
    await page.locator('[role="tab"]:has-text("History")').click()
    const row = page.locator(`.desktop-list .desktop-list-row:has([title="${summary}"])`).first()
    await row.waitFor({ state: "visible", timeout: 15000 })
    await row.evaluate(element => {
      const rect = element.getBoundingClientRect()
      element.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: rect.x + 4, clientY: rect.y + 4 })
      )
    })
  }
  try {
    // Desktop getContextMenuForSingleCommit：当前提交不能检出，较早的可以，检出前先确认
    await openMenu("checkout probe tip")
    const checkoutItem = page.locator('[role="menuitem"]:has-text("Checkout Commit")')
    await checkoutItem.waitFor({ state: "visible" })
    assert.equal(await checkoutItem.evaluate(element => element.hasAttribute("data-disabled")), true)
    await page.keyboard.press("Escape")
    await openMenu("checkout probe base")
    await page.locator('[role="menuitem"]:has-text("Checkout Commit")').click()
    await expect(page.locator("#checkout-commit")).toContainText("detached HEAD")
    await page.locator('#checkout-commit button:has-text("Checkout")').click()
    await expect.poll(() => git("rev-parse", "HEAD"), { timeout: 15000 }).toBe(base)
    assert.equal(git("branch", "--show-current"), "")
    await page.locator("#checkout-commit").waitFor({ state: "hidden" })

    await openMenu("checkout probe tip")
    await page.locator('[role="menuitem"]:has-text("Create Branch from Commit")').click()
    await expect(page.locator("#create-branch")).toContainText("checkout probe tip")
    await page.locator("#create-branch input").fill("checkout-probe")
    await page.locator('#create-branch button[type="submit"]').click()
    await expect.poll(() => git("branch", "--show-current"), { timeout: 15000 }).toBe("checkout-probe")
    assert.equal(git("rev-parse", "HEAD"), tip)
  } finally {
    git("checkout", "-q", branch)
    git("reset", "-q", "--hard", head)
    try {
      git("branch", "-q", "-D", "checkout-probe")
    } catch {
      // 用例在建分支之前就失败了
    }
    if (stashed) git("stash", "pop", "-q")
  }
})

test("rebasing a branch whose upstream would be rewritten warns about force push first", async ({
  mainWindow: page
}) => {
  // Desktop startRebase → warnAboutRemoteCommits：上游有目标分支里没有的提交，变基后必须强推
  const head = git("rev-parse", "HEAD")
  assert.notEqual(git("rev-parse", "--abbrev-ref", "@{upstream}"), "")
  const orphan = git("commit-tree", "-m", "rebase probe target", git("hash-object", "-t", "tree", "/dev/null"))
  git("branch", "rebase-probe-target", orphan)
  try {
    await page.evaluate(async () =>
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "rebase-branch" })
    )
    // 下拉进了「选分支变基」模式再点，否则点到的是普通检出
    await page.locator(".branches-action-hint").waitFor({ state: "visible", timeout: 15000 })
    // 前面的用例留下不少分支，先过滤，目标一定在列表可见区里
    await page.locator(".branches-container .filter-list-filter-field input").fill("rebase-probe-target")
    const target = page.locator('.branches-list-item .name:has-text("rebase-probe-target")')
    await target.waitFor({ state: "visible", timeout: 15000 })
    await target.click()
    const warning = page.locator("#warn-force-push")
    await expect(warning).toContainText("Rebase Will Require Force Push", { timeout: 15000 })
    await warning.locator('button:has-text("Cancel")').click()
    await warning.waitFor({ state: "hidden" })
    assert.equal(git("rev-parse", "HEAD"), head)
  } finally {
    if (git("rev-parse", "HEAD") !== head) git("reset", "-q", "--keep", head)
    git("branch", "-D", "rebase-probe-target")
  }
})

test("changes filter options count the files currently listed", async ({ mainWindow: page }) => {
  // Desktop changes-list-filter-options：每项后面是当前列表里符合的文件数，筛选生效后才有「Clear filters」
  const probe = join(smokeRepoPath, "filter-count-probe.txt")
  writeFileSync(probe, "count me\n")
  try {
    await page.locator('[role="tab"]:has-text("Changes")').click()
    await page.locator('input[placeholder="Filter"]').fill("filter-count-probe")
    await page.locator('.list-scroller [title="filter-count-probe.txt"]').waitFor({ state: "visible", timeout: 15000 })
    await page.locator('button[aria-label="Filter Options"]').click()
    const item = (label: string) => page.locator(`[role="menuitemcheckbox"]:has-text("${label}")`)
    await item("New files (1)").waitFor({ state: "visible" })
    await item("Modified files (0)").waitFor({ state: "visible" })
    await item("Included in commit (1)").waitFor({ state: "visible" })
    assert.equal(await page.locator('[role="menuitem"]:has-text("Clear filters")').isVisible(), false)
    await item("Modified files (0)").click()
    await page.keyboard.press("Escape")
    await page.locator('button[aria-label="Filter Options (1 applied)"]').click()
    await page.locator('[role="menuitem"]:has-text("Clear filters")').click()
    await page.locator('button[aria-label="Filter Options"]').waitFor({ state: "visible" })
  } finally {
    await page.locator('input[placeholder="Filter"]').fill("")
    rmSync(probe, { force: true })
  }
})

test("squashing selected commits asks for the squashed commit message first", async ({ mainWindow: page }) => {
  // Desktop getContextMenuMultipleCommits → compare.onSquash：先弹 CommitMessage（摘要取右键的那条，
  // 描述合并其余各条），确认后才压缩
  const head = git("rev-parse", "HEAD")
  for (const summary of ["squash probe a", "squash probe b", "squash probe c"])
    git("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", summary, "-m", `${summary} body`)
  const base = git("rev-parse", "HEAD~2")
  const row = (summary: string) => page.locator(`.desktop-list .desktop-list-row:has([title="${summary}"])`).first()
  try {
    await page.locator('[role="tab"]:has-text("History")').click()
    await row("squash probe c").waitFor({ state: "visible", timeout: 15000 })
    await row("squash probe c").click()
    await row("squash probe b").evaluate(element =>
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }))
    )
    await row("squash probe b").evaluate(element => {
      const rect = element.getBoundingClientRect()
      element.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: rect.x + 4, clientY: rect.y + 4 })
      )
    })
    await page.locator('[role="menuitem"]:has-text("Squash 2 Commits…")').click()
    const dialog = page.locator("#commit-message-dialog")
    await expect(dialog).toContainText("Squash 2 Commits", { timeout: 15000 })
    assert.equal(
      await dialog.locator(".summary-field input").evaluate(input => (input as HTMLInputElement).value),
      "squash probe b"
    )
    await dialog.locator('button.commit-button:has-text("Squash 2 Commits")').click()
    const warning = page.locator("#warn-force-push")
    await expect
      .poll(async () => (await warning.isVisible()) || git("rev-parse", "HEAD~1") === base, { timeout: 15000 })
      .toBe(true)
    if (await warning.isVisible()) await warning.locator('button:has-text("Begin Squash")').click()
    await expect.poll(() => git("rev-parse", "HEAD~1"), { timeout: 15000 }).toBe(base)
    assert.equal(git("log", "-1", "--format=%s"), "squash probe b")
    const body = git("log", "-1", "--format=%b")
    assert.match(body, /squash probe b body/)
    assert.match(body, /squash probe c/)
  } finally {
    git("reset", "-q", "--keep", head)
  }
})

test("keyboard reorder moves the commit to the chosen location", async ({ mainWindow: page }) => {
  // Desktop getContextMenuForSingleCommit「Reorder Commit」→ List keyboardInsertion：
  // ↓ 选插入位置，Enter 确认，按 onDropDataInsertion 插到那一行之前
  const head = git("rev-parse", "HEAD")
  for (const summary of ["reorder probe a", "reorder probe b", "reorder probe c"])
    git("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", summary)
  const row = (summary: string) => page.locator(`.desktop-list .desktop-list-row:has([title="${summary}"])`).first()
  try {
    await page.locator('[role="tab"]:has-text("History")').click()
    await row("reorder probe c").waitFor({ state: "visible", timeout: 15000 })
    await row("reorder probe c").evaluate(element => {
      const rect = element.getBoundingClientRect()
      element.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: rect.x + 4, clientY: rect.y + 4 })
      )
    })
    await page.locator('[role="menuitem"]:has-text("Reorder Commit")').click()
    await expect(page.locator(".reorder-commits-hint-popover")).toContainText("Reorder Commits", { timeout: 15000 })
    // 从 c 自己的位置往下两格：插到 a 之前，即 c 排到 b 与 a 之间
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Enter")
    const warning = page.locator("#warn-force-push")
    await expect
      .poll(
        async () =>
          (await warning.isVisible()) ||
          git("log", "-3", "--format=%s").split("\n").join(",") !== "reorder probe c,reorder probe b,reorder probe a",
        { timeout: 15000 }
      )
      .toBe(true)
    if (await warning.isVisible()) await warning.locator('button:has-text("Begin Reorder")').click()
    await expect
      .poll(() => git("log", "-3", "--format=%s").split("\n").join(","), { timeout: 15000 })
      .toBe("reorder probe b,reorder probe c,reorder probe a")
    assert.equal(await page.locator(".reorder-commits-hint-popover").isVisible(), false)
  } finally {
    git("reset", "-q", "--keep", head)
  }
})

test("history list and commit details render :alias: emoji from the gemoji table", async ({ mainWindow: page }) => {
  // Desktop CommitListItem / ExpandableCommitSummary 都经 RichText 把 :alias: 换成 emoji；悬停提示保留原文
  const head = git("rev-parse", "HEAD")
  const summary = ":sparkles: emoji probe :nope:"
  git("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", summary, "-m", "Body :tada: done")
  try {
    await page.locator('[role="tab"]:has-text("History")').click()
    const row = page.locator(`.desktop-list .desktop-list-row [title="${summary}"]`).first()
    await row.waitFor({ state: "visible", timeout: 15000 })
    await expect.poll(() => row.textContent(), { timeout: 15000 }).toBe("✨ emoji probe :nope:")
    await row.click()
    await expect(page.locator("#expandable-commit-summary .ecs-title")).toContainText("✨ emoji probe :nope:", {
      timeout: 15000
    })
    await expect(page.locator("#expandable-commit-summary .ecs-description-text")).toContainText("Body 🎉 done")
  } finally {
    git("reset", "-q", "--keep", head)
  }
})

test("file history truncates a long path inside the header and hides search, compare and reordering", async ({
  mainWindow: page
}) => {
  // 原 Storybook History/FileHistory play：路径在标签里省略、标签不压关闭按钮、搜索与比较收起、行不能拖
  const head = git("rev-parse", "HEAD")
  const dir = "packages/gitcub/features/history"
  const file = `${dir}/very-long-name-for-a-commit-file-component.tsx`
  const createdRoot = !existsSync(join(smokeRepoPath, "packages"))
  mkdirSync(join(smokeRepoPath, dir), { recursive: true })
  writeFileSync(join(smokeRepoPath, file), "export {}\n")
  git("add", "--", file)
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "file history probe")
  writeFileSync(join(smokeRepoPath, file), "export const probe = 1\n")
  try {
    await page.locator('[role="tab"]:has-text("Changes")').first().click()
    await page.locator(`.list-scroller [title="${file}"]`).waitFor({ state: "visible", timeout: 15000 })
    await page.evaluate(name => {
      const row = document.querySelector(`.list-scroller [title="${name}"]`)!
      const rect = row.getBoundingClientRect()
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: rect.x + 4, clientY: rect.y + 4 })
      )
    }, file)
    await page.locator('[role="menuitem"]:has-text("Show file history")').click()
    const chip = page.locator(`[title="File history: ${file}"]`)
    await chip.waitFor({ state: "visible", timeout: 15000 })
    await page
      .locator('.desktop-list .desktop-list-row:has-text("file history probe")')
      .first()
      .waitFor({ state: "visible", timeout: 15000 })
    const geometry = await page.evaluate(name => {
      const chip = document.querySelector<HTMLElement>(`[title="File history: ${name}"]`)!
      const text = chip.querySelector("span")!
      const close = document.querySelector<HTMLElement>('button[aria-label="Back to all commits"]')!
      const header = chip.parentElement!
      const row = [...document.querySelectorAll<HTMLElement>(".desktop-list .desktop-list-row")].find(node =>
        node.textContent?.includes("file history probe")
      )!
      return {
        overflowing: text.scrollWidth > text.clientWidth,
        // 截断而不是被标签裁掉：文字框自身省略号收尾，且不超出标签
        ellipsis: getComputedStyle(text).textOverflow === "ellipsis" && getComputedStyle(text).overflow === "hidden",
        textRight: text.getBoundingClientRect().right,
        chipRight: chip.getBoundingClientRect().right,
        closeLeft: close.getBoundingClientRect().left,
        closeRight: close.getBoundingClientRect().right,
        headerRight: header.getBoundingClientRect().right,
        // 只看历史侧栏（标签所在一行的父容器），左侧仓库栏有自己的搜索框
        search: header.parentElement!.querySelector('input[placeholder^="Search commits"]') !== null,
        compare: [...header.parentElement!.querySelectorAll("button")].some(button =>
          button.textContent?.startsWith("Compare")
        ),
        draggable: row.closest("[draggable]")?.getAttribute("draggable") ?? null
      }
    }, file)
    assert.equal(geometry.overflowing, true)
    assert.equal(geometry.ellipsis, true)
    assert.ok(geometry.textRight <= geometry.chipRight, JSON.stringify(geometry))
    assert.ok(geometry.chipRight <= geometry.closeLeft, JSON.stringify(geometry))
    assert.ok(geometry.closeRight <= geometry.headerRight, JSON.stringify(geometry))
    assert.equal(geometry.search, false)
    assert.equal(geometry.compare, false)
    assert.equal(geometry.draggable, "false")
    await page.locator('button[aria-label="Back to all commits"]').click()
    await page.locator('input[placeholder^="Search commits"]').first().waitFor({ state: "visible", timeout: 15000 })
  } finally {
    git("reset", "-q", "--hard", head)
    if (createdRoot) rmSync(join(smokeRepoPath, "packages"), { recursive: true, force: true })
  }
})

test("changing the upstream outside the app refreshes the push button", async ({ mainWindow: page }) => {
  // 上游只记在 .git/config；监听要认它，否则状态里的上游一直是旧的
  const branch = git("branch", "--show-current")
  const upstream = git("rev-parse", "--abbrev-ref", "@{upstream}")
  git("update-ref", "refs/remotes/origin/upstream-probe", "HEAD")
  try {
    await expect(page.locator(".push-pull-button")).toContainText("origin", { timeout: 15000 })
    git("branch", "-q", "--set-upstream-to", "origin/upstream-probe", branch)
    await expect(page.locator(".push-pull-button")).toContainText("origin/upstream-probe", { timeout: 15000 })
  } finally {
    git("branch", "-q", "--set-upstream-to", upstream, branch)
    git("update-ref", "-d", "refs/remotes/origin/upstream-probe")
  }
  await expect
    .poll(async () =>
      (await page.locator(".push-pull-button").evaluate(element => element.textContent ?? "")).includes(
        "upstream-probe"
      )
    )
    .toBe(false)
})

// 原 stories 里要真实布局、解码、剪贴板和动画帧的 play（LargeDiffSearch、SelectAllCopiesUnmountedRows、
// DragOutsideViewport、RecoverAfterLoadFailure、HundredThousandLines、MatchesLoginAndName），在原生 WebKit 里验证
test("100000-line diff finds the last line, copies unmounted rows and auto-scrolls a drag past the viewport", async ({
  mainWindow: page
}) => {
  const file = "large-search.txt"
  writeFileSync(join(smokeRepoPath, file), Array.from({ length: 100000 }, (_, n) => `large line ${n}\n`).join(""))
  try {
    await page.locator('[role="tab"]:has-text("Changes")').first().click()
    const entry = page.locator(`.list-scroller [title="${file}"]`)
    await entry.waitFor({ state: "visible", timeout: 15000 })
    await entry.click()
    await page.locator(".diff-container .unified-diff").waitFor({ state: "visible", timeout: 20000 })
    const rows = () => page.evaluate(() => document.querySelectorAll(".unified-diff .row").length)
    // 搜索：菜单「查找」弹出搜索框，回车跳到第十万行，仍只渲染可见的几十行
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "find-text" })
    )
    const search = page.locator(".diff-search input")
    await search.click()
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>(".diff-search input")!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "large line 99999")
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "9" }))
    })
    await expect.poll(() => search.inputValue()).toBe("large line 99999")
    // 回车在页内派发（原生按键注入在高负载下偶发等不到 keyup）；只按一次，播报有防抖，连按会一直被重置
    await page.evaluate(() =>
      document
        .querySelector(".diff-search input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    )
    await expect(page.locator(".diff-container")).toContainText('Result 1 of 1 for "large line 99999"', {
      timeout: 15000
    })
    await expect(page.locator(".unified-diff .cm-search-result-current")).toContainText("large line 99999")
    assert.ok((await rows()) < 1000)
    // 焦点移回 diff，搜索框失焦收起（Desktop：失焦即关闭）
    await page.evaluate(() => document.querySelector<HTMLElement>(".unified-diff")!.focus())
    await page.locator(".diff-search").waitFor({ state: "hidden" })
    // 全选后复制：没挂载的虚拟行也在剪贴板文本里（Desktop onCutOrCopy 连同 hunk 头一起复制，
    // 每行取 DiffLine.content，即去掉首字符的 text，所以 hunk 头剩一个 @）
    const copied = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".unified-diff")!
      viewport.dispatchEvent(new CustomEvent("select-all", { bubbles: true, cancelable: true }))
      const clipboardData = new DataTransfer()
      viewport.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }))
      return clipboardData.getData("text/plain")
    })
    const copiedLines = copied.split("\n")
    assert.match(copiedLines[0], /^@ -0,0 \+1,100000 @@/)
    assert.equal(copiedLines[1], "large line 0")
    assert.equal(copiedLines.length, 100001)
    assert.equal(copiedLines.at(-1), "large line 99999")
    assert.ok((await rows()) < 1000)
    // 拖选越过视口下沿：按动画帧持续滚动，松开后整段改成拖选起点的相反状态
    const dragged = await page.evaluate(async () => {
      const viewport = document.querySelector<HTMLElement>(".unified-diff")!
      viewport.scrollTop = 0
      await new Promise(resolve => setTimeout(resolve, 200))
      const gutter = document.querySelector('[aria-label="Line 1 added"]')!.closest<HTMLElement>(".line-number")!
      const rect = viewport.getBoundingClientRect()
      const start = gutter.getBoundingClientRect()
      gutter.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          clientX: start.x + start.width / 2,
          clientY: start.y + start.height / 2
        })
      )
      document.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: start.x + start.width / 2, clientY: rect.bottom + 10 })
      )
      const until = Date.now() + 5000
      // 原 play 的门槛：越过下沿后滚过 80px（窗口被遮挡时 WebKit 会给动画帧降频，不按帧数算）
      while (viewport.scrollTop <= 80 && Date.now() < until) await new Promise(requestAnimationFrame)
      const scrolled = viewport.scrollTop
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }))
      await new Promise(resolve => setTimeout(resolve, 200))
      viewport.scrollTop = 0
      await new Promise(resolve => setTimeout(resolve, 300))
      const checked = (line: number) =>
        document.querySelector<HTMLInputElement>(`input[aria-label="Line ${line} added"]`)?.checked
      return { scrolled, first: checked(1), second: checked(2) }
    })
    assert.ok(dragged.scrolled > 80, `auto-scrolled ${dragged.scrolled}px`)
    assert.equal(dragged.first, false)
    assert.equal(dragged.second, false)
  } finally {
    rmSync(join(smokeRepoPath, file), { force: true })
  }
})

test("an image that fails to decode shows an error and the next valid revision replaces it", async ({
  mainWindow: page
}) => {
  const file = "broken-image.png"
  writeFileSync(join(smokeRepoPath, file), Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]))
  try {
    await page.locator('[role="tab"]:has-text("Changes")').first().click()
    const entry = page.locator(`.list-scroller [title="${file}"]`)
    await entry.waitFor({ state: "visible", timeout: 15000 })
    await entry.click()
    await expect(page.locator('[role="alert"]:has-text("Unable to load")')).toContainText("Unable to load this image", {
      timeout: 15000
    })
    assert.equal(await page.evaluate(() => document.querySelectorAll('img[alt="Added image"]').length), 0)
    // 1×1 透明 PNG
    writeFileSync(
      join(smokeRepoPath, file),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64"
      )
    )
    await expect
      .poll(
        () => page.evaluate(() => document.querySelector<HTMLImageElement>('img[alt="Added image"]')?.naturalWidth),
        { timeout: 15000 }
      )
      .toBe(1)
    assert.equal(
      await page.evaluate(
        () =>
          [...document.querySelectorAll('[role="alert"]')].filter(n => n.textContent?.includes("Unable to load")).length
      ),
      0
    )
  } finally {
    rmSync(join(smokeRepoPath, file), { force: true })
  }
})

test("a github.com repository completes @Copilot and :smile: in the commit description and Enter inserts them", async ({
  mainWindow: page
}) => {
  const previousOrigin = git("remote", "get-url", "origin")
  git("remote", "set-url", "origin", "https://github.com/gitcub/mention-fixture.git")
  // 工作区改动触发仓库刷新，远端随状态一起重读（refreshRepository → setRemote）
  const touched = join(smokeRepoPath, "mention-refresh.txt")
  writeFileSync(touched, "refresh remote\n")
  try {
    await page.locator('[role="tab"]:has-text("Changes")').first().click()
    await page.locator('.list-scroller [title="mention-refresh.txt"]').waitFor({ state: "visible", timeout: 15000 })
    const description = page.locator("#commit-message-description")
    await description.waitFor({ state: "visible" })
    // 照真实输入：改值、光标放到末尾、派发 input 事件（hasgard 的 fill 不保证补全所需的光标位置）
    const type = (value: string) =>
      page.evaluate(text => {
        const input = document.querySelector<HTMLTextAreaElement>("#commit-message-description")!
        input.focus()
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text)
        input.setSelectionRange(text.length, text.length)
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text.slice(-1) }))
      }, value)
    await expect
      .poll(
        async () => {
          await type("")
          await type("Thanks @cop")
          await new Promise(resolve => setTimeout(resolve, 300))
          return page.evaluate(() => document.querySelector(".autocompletion-popup")?.textContent ?? "")
        },
        { timeout: 15000 }
      )
      .toContain("Copilot")
    // Desktop onKeyDown：Enter 只插入已选中的候选，先按 ↓ 选中第一行（页内派发键盘事件，原生注入在这里会等不到 keyup）
    await page.evaluate(async () => {
      const input = document.querySelector<HTMLTextAreaElement>("#commit-message-description")!
      for (const key of ["ArrowDown", "Enter"]) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    })
    await expect.poll(() => description.inputValue()).toBe("Thanks @Copilot ")
    // emoji 表（gemoji，空闲时按需加载）：`:smil` 补出 :smile:，↓ Enter 插入字符
    await expect
      .poll(
        async () => {
          await type("Thanks @Copilot :smil")
          await new Promise(resolve => setTimeout(resolve, 300))
          return page.evaluate(() => document.querySelector(".autocompletion-popup")?.textContent ?? "")
        },
        { timeout: 15000 }
      )
      .toContain("smile")
    await page.evaluate(async () => {
      const input = document.querySelector<HTMLTextAreaElement>("#commit-message-description")!
      for (const key of ["ArrowDown", "Enter"]) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    })
    await expect.poll(() => description.inputValue()).toBe("Thanks @Copilot 😄 ")
  } finally {
    await page.locator("#commit-message-description").fill("")
    rmSync(touched, { force: true })
    git("remote", "set-url", "origin", previousOrigin)
  }
})

test("blame of a 100000-line file stays virtualized and the last line opens its commit", async ({
  mainWindow: page
}) => {
  const file = "large-blame.txt"
  const lines = Array.from({ length: 100000 }, (_, n) => `large blame ${n}\n`)
  writeFileSync(join(smokeRepoPath, file), lines.join(""))
  git("add", "--", file)
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "large blame baseline")
  lines[99999] = "large blame last\n"
  writeFileSync(join(smokeRepoPath, file), lines.join(""))
  git("add", "--", file)
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "change the last blame line")
  // 再改一行，文件出现在改动列表里，从它的右键菜单进 blame
  writeFileSync(join(smokeRepoPath, file), `${lines.join("")}tail\n`)
  try {
    const entry = page.locator(`.list-scroller [title="${file}"]`)
    await entry.waitFor({ state: "visible", timeout: 15000 })
    await page.evaluate(name => {
      const row = document.querySelector(`.list-scroller [title="${name}"]`)!
      const rect = row.getBoundingClientRect()
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: rect.x + 4, clientY: rect.y + 4 })
      )
    }, file)
    await page.locator('[role="menuitem"]:has-text("Blame…")').click()
    const region = page.locator('[role="region"][aria-label="Blame"]')
    await expect(region).toContainText("large blame 0", { timeout: 30000 })
    const rendered = () => page.evaluate(() => document.querySelectorAll('[aria-label="Blame"] .whitespace-pre').length)
    assert.ok((await rendered()) < 200)
    await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('[role="region"][aria-label="Blame"]')!
      viewport.scrollTop = viewport.scrollHeight
      viewport.dispatchEvent(new Event("scroll"))
    })
    await expect(region).toContainText("large blame last", { timeout: 15000 })
    assert.ok((await rendered()) < 200)
    await page.evaluate(() => {
      const line = [...document.querySelectorAll('[aria-label="Blame"] .whitespace-pre')].find(
        node => node.textContent === "large blame last"
      )!
      line.parentElement!.querySelector("button")!.click()
    })
    // 照 Desktop：关掉 blame，切到历史并选中这一行所在的提交
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.stringify({
            history: [...document.querySelectorAll('[role="tab"]')].some(
              tab => tab.textContent?.includes("History") && tab.getAttribute("aria-selected") === "true"
            ),
            blame: document.querySelectorAll('[role="region"][aria-label="Blame"]').length
          })
        )
      )
      .toBe(JSON.stringify({ history: true, blame: 0 }))
    await expect(page.locator(".diff-container")).toContainText(file, { timeout: 15000 })
    await expect(page.locator("body")).toContainText("change the last blame line")
  } finally {
    git("checkout", "--", file)
    await page.locator('[role="tab"]:has-text("Changes")').first().click()
  }
})

test("saved Chinese language applies to welcome and Git identity before onboarding", async ({ mainWindow: page }) => {
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: "preferences" })
  })
  await page.locator('[role="tab"]:has-text("Advanced")').click()
  await page.locator('button:has-text("简体中文")').click()
  // 照 Desktop 设置对话框：点「保存」才写回
  await page.locator('[role="dialog"] button:has-text("Save")').click()
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
  // 这里只验证语言设置落盘后在原生欢迎流程里生效
  await page.locator("a.skip-button").click()
  await expect(page.locator(".welcome-title")).toContainText("配置 Git")
  await page.locator('input[placeholder="你的姓名"]').waitFor({ state: "visible" })
  await page.locator('button:has-text("完成")').waitFor({ state: "visible" })
})
