// Platform adapter for the unchanged Desktop E2E suite. Every DOM query and
// interaction below is executed in the running Tauri WebView through Hasgard.
import assert from "node:assert/strict"
import { type ChildProcess, execFile, spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, afterEach, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { ensureSmokeTestRepository, smokeRepoPath } from "../upstream/desktop/e2e/test-helpers.ts"
import { createMockUpdateServer, type IMockUpdateServer, MOCK_CONTROL_URL } from "./mock-update-server.ts"

const exec = promisify(execFile)
const root = fileURLToPath(new URL("../../..", import.meta.url))
// macOS Unix socket paths are limited to 104 bytes; TMPDIR may already be
// nested under the runner's isolated directory.
const directory = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "gitcub-e2e-"))
const socket = join(directory, "hasgard.sock")
const artifacts = join(
  root,
  "test-results",
  process.argv.some(arg => arg.includes("macos-workflows")) ? "macos-workflows" : "desktop-e2e"
)
let app: ChildProcess
let mockServer: IMockUpdateServer
const trace: Array<{ time: string; command: string[]; result?: unknown; error?: string }> = []

const memorySamples: Array<{ stage: string; rssKiB: number; at: string }> = []

/** Native host RSS only: WebKit runs in separate OS-managed processes. */
export async function recordNativeMemory(stage: string) {
  if (!app?.pid) throw new Error("Application has not started")
  const { stdout } = await exec("ps", ["-p", String(app.pid), "-o", "rss="])
  const rssKiB = Number(stdout.trim())
  assert.ok(Number.isFinite(rssKiB) && rssKiB > 0, "Missing native host RSS")
  memorySamples.push({ stage, rssKiB, at: new Date().toISOString() })
  await mkdir(artifacts, { recursive: true })
  await writeFile(
    join(artifacts, "native-memory.json"),
    `${JSON.stringify(
      {
        scope:
          "Native application host RSS; excludes WebKit renderer/GPU. Observational baseline, not a leak or total-memory certification.",
        samples: memorySamples
      },
      null,
      2
    )}\n`
  )
  return rssKiB
}

async function hasgard<T = unknown>(...args: string[]): Promise<T> {
  const entry: (typeof trace)[number] = { time: new Date().toISOString(), command: args }
  trace.push(entry)
  try {
    const { stdout } = await exec("tauri-hasgard", ["--socket", socket, "--json", ...args], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024
    })
    const value = JSON.parse(stdout)
    if (value?.error) throw new Error(JSON.stringify(value.error))
    entry.result = value
    return value as T
  } catch (error) {
    entry.error = String(error)
    throw error
  }
}

// WebKit's own snapshot shows what is actually painted, scrolled lists included;
// the DOM rasteriser stays as the fallback for hosts without it.
async function capture(path: string) {
  return hasgard("screenshot_native", "--output", path).catch(() => hasgard("screenshot", path))
}

async function poll<T>(get: () => Promise<T> | T, check: (value: T) => void, timeout = 15_000, interval = 100) {
  const deadline = Date.now() + timeout
  let failure: unknown
  do {
    try {
      check(await get())
      return
    } catch (error) {
      failure = error
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  } while (Date.now() < deadline)
  throw failure
}

// This function is serialized and executed only inside the real WebView.
function locate(chain: Array<{ selector: string; first?: boolean }>): Element[] {
  let roots: (Document | Element)[] = [document]
  for (const step of chain) {
    const matches: Element[] = []
    for (const root of roots) {
      if (step.selector.startsWith("//")) {
        const result = document.evaluate(
          root === document ? step.selector : `.${step.selector}`,
          root,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE
        )
        for (let i = 0; i < result.snapshotLength; i++) matches.push(result.snapshotItem(i) as Element)
      } else {
        const text = /:has-text\("([^"]*)"\)/.exec(step.selector)
        const css = step.selector.replaceAll(/:has-text\("[^"]*"\)/g, "")
        matches.push(
          ...[...root.querySelectorAll(css)].filter(element => !text || element.textContent?.includes(text[1]))
        )
      }
    }
    roots = step.first ? matches.slice(0, 1) : matches
  }
  return roots as Element[]
}

class Locator {
  constructor(readonly chain: Array<{ selector: string; first?: boolean }>) {}
  locator(selector: string) {
    return new Locator([...this.chain, { selector }])
  }
  first() {
    const chain = this.chain.map(step => ({ ...step }))
    chain.at(-1)!.first = true
    return new Locator(chain)
  }
  private async inspect<T = unknown>(expression: string): Promise<T> {
    return hasgard<T>(
      "eval",
      `(() => { const elements = (${locate.toString()})(${JSON.stringify(this.chain)}); const el = elements[0]; ${expression} })()`
    )
  }
  isVisible() {
    return this.inspect<boolean>(
      'return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"'
    )
  }
  isEnabled() {
    return this.inspect<boolean>(
      'return !!el && !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true"'
    )
  }
  textContent() {
    return this.inspect<string | null>('if (!el) throw new Error("Element not found"); return el.textContent')
  }
  inputValue() {
    return this.inspect<string>('if (!el) throw new Error("Input not found"); return el.value')
  }
  async waitFor(options: { state: string; timeout?: number }) {
    await poll(
      () => this.isVisible(),
      value => assert.equal(value, options.state !== "hidden"),
      options.timeout
    )
  }
  private async target() {
    await this.waitFor({ state: "visible" })
    const id = `gitcub-e2e-${crypto.randomUUID()}`
    await this.inspect(
      `if (!el) throw new Error("Element not found"); el.setAttribute("data-gitcub-e2e-target", ${JSON.stringify(id)}); return true`
    )
    return `[data-gitcub-e2e-target="${id}"]`
  }
  async click() {
    await hasgard("click", await this.target())
  }
  async fill(value: string) {
    await hasgard("fill", await this.target(), value)
  }
  async evaluate<R, A = undefined>(fn: (element: HTMLElement, value: A) => R, value?: A) {
    return this.inspect<Awaited<R>>(
      `if (!el) throw new Error("Element not found"); return (${fn.toString()})(el, ${JSON.stringify(value) ?? "undefined"})`
    )
  }
}

export class Page {
  async screenshot(path: string) {
    return capture(path)
  }
  readonly keyboard = { press: (key: string) => hasgard("press", key) }
  locator(selector: string) {
    return new Locator([{ selector }])
  }
  async evaluate<R, A = undefined>(fn: (value: A) => R, value?: A): Promise<Awaited<R>> {
    // Exact Electron menu/quit API actions translate to their native Tauri
    // counterparts. process.pid identifies the Tauri process hosting this window.
    return hasgard<Awaited<R>>(
      "eval",
      `(async () => {
      const process = { pid: ${app.pid} };
      // The source loader rewrites require("electron") in the suite to the local
      // electron.ts shim path before fn.toString() runs; accept both spellings.
      const require = name => {
        if (name !== "electron" && !/[\\/]electron\\.ts$/.test(name)) throw new Error("Unsupported browser module: " + name);
        return { ipcRenderer: {
          emit: (event, _sender, ...payload) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event, payload }),
          send: event => { if (event !== "quit-app") throw new Error("Unsupported IPC: " + event); return window.__TAURI_INTERNALS__.invoke("request_quit", { force: false }); }
        }};
      };
      return (${fn.toString()})(${JSON.stringify(value) ?? "undefined"});
    })()`
    )
  }
  async waitForFunction<R, A = undefined>(fn: (value: A) => R, value?: A, options?: { timeout?: number }) {
    await poll(
      () => this.evaluate(fn, value),
      result => assert.ok(result),
      options?.timeout
    )
  }
  waitForSelector(selector: string, options: { state: string; timeout?: number }) {
    return this.locator(selector).waitFor(options)
  }
  context() {
    return {
      tracing: {
        stop: async ({ path }: { path: string }) => {
          await mkdir(dirname(path), { recursive: true })
          const logs = await hasgard<{ args?: unknown[] }[]>("logs")
          await writeFile(join(directory, "trace.json"), JSON.stringify({ trace, logs }, null, 2))
          await capture(join(directory, "final.png"))
          await exec("zip", ["-j", path, join(directory, "trace.json"), join(directory, "final.png")])
          await cp(path, join(artifacts, "trace.zip"))
        }
      }
    }
  }
}

export const test = Object.assign(
  (name: string, body: (fixtures: { mainWindow: Page; mockServer: IMockUpdateServer }) => Promise<void>) =>
    it(name, { timeout: 90_000 }, async () => body({ mainWindow: new Page(), mockServer })),
  {
    describe: Object.assign(describe, {
      configure: (options: { mode: string }) => assert.equal(options.mode, "serial")
    }),
    skip: (condition: boolean, reason: string) => {
      if (condition) throw new Error(`Required E2E case cannot run: ${reason}`)
    }
  }
)

function matchers(value: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(value, expected),
    toMatch: (expected: RegExp) => {
      assert.equal(typeof value, "string")
      assert.match(value as string, expected)
    },
    toContain: (expected: string) => {
      assert.equal(typeof value, "string")
      assert.ok(
        (value as string).includes(expected),
        `${JSON.stringify(value)} does not contain ${JSON.stringify(expected)}`
      )
    },
    toBeGreaterThanOrEqual: (expected: number) => {
      assert.equal(typeof value, "number")
      assert.ok((value as number) >= expected)
    },
    toContainText: async (expected: string, options?: { timeout?: number }) => {
      assert.ok(value instanceof Locator)
      await poll(
        () => value.textContent(),
        text =>
          assert.ok(text?.includes(expected), `${JSON.stringify(text)} does not contain ${JSON.stringify(expected)}`),
        options?.timeout
      )
    },
    not: {
      toBeVisible: async () => {
        assert.ok(value instanceof Locator)
        await poll(
          () => value.isVisible(),
          visible => assert.equal(visible, false)
        )
      }
    }
  }
}
export const expect = Object.assign(matchers, {
  poll: (get: () => unknown, options?: { timeout?: number; intervals?: number[] }) => ({
    toBe: (expected: unknown) =>
      poll(get, value => matchers(value).toBe(expected), options?.timeout, options?.intervals?.[0]),
    toMatch: (expected: RegExp) =>
      poll(get, value => matchers(value).toMatch(expected), options?.timeout, options?.intervals?.[0]),
    toContain: (expected: string) =>
      poll(get, value => matchers(value).toContain(expected), options?.timeout, options?.intervals?.[0]),
    toBeGreaterThanOrEqual: (expected: number) =>
      poll(get, value => matchers(value).toBeGreaterThanOrEqual(expected), options?.timeout, options?.intervals?.[0])
  })
})

export async function controlMockServer(action: string) {
  return (await fetch(`${MOCK_CONTROL_URL}/${action}`)).text()
}
export async function getMockRequests(): Promise<Array<{ method: string; url: string }>> {
  return (await fetch(`${MOCK_CONTROL_URL}/requests`)).json()
}
export async function dismissMoveToApplicationsDialog(page: Page) {
  const dialog = page.locator("#move-to-applications-folder")
  if (await dialog.isVisible()) await dialog.locator('button[type="submit"]').click()
}
/** 跳过登录离开欢迎流程。全局 git 已有 name 和 email 时欢迎流程直接结束，
 *  没有时才进「配置 Git」，这里填入给定身份。前面的套件可能已写过全局身份，两种都要接受。 */
export async function skipWelcome(page: Page, name: string, email: string) {
  await page.locator("a.skip-button").click()
  const input = page.locator('input[placeholder="Your Name"]')
  const welcome = page.locator("#welcome")
  await poll(
    async () => (await input.isVisible()) || !(await welcome.isVisible()),
    done => assert.ok(done, "welcome neither asked for a Git identity nor finished")
  )
  if (await input.isVisible()) {
    await input.fill(name)
    await page.locator('input[placeholder="your-email@example.com"]').fill(email)
    await page.locator('button:has-text("Finish")').click()
  }
  await page.waitForSelector("#welcome", { state: "hidden", timeout: 15000 })
}
export function terminateWindowsUpdaterProcesses() {
  // Tauri's downloader belongs to the application; it never spawns Squirrel.
  assert.ok(app?.exitCode !== null || app.signalCode !== null, "Tauri updater process is still alive")
}

before(
  async () => {
    await mkdir(artifacts, { recursive: true })
    ensureSmokeTestRepository()
    mockServer = await createMockUpdateServer()
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({ repositories: [smokeRepoPath], selectedRepository: smokeRepoPath, language: "en" })
    )
    const desktopProfile = join(directory, "desktop-profile")
    if (process.argv.some(arg => arg.includes("macos-workflows"))) await mkdir(desktopProfile)
    const output: string[] = []
    let executable = join(root, "src-tauri/target/debug/gitcub")
    if (process.platform === "darwin") {
      const bundle = join(directory, "GitCub Conformance.app")
      await cp(join(root, "src-tauri/target/debug/bundle/macos/GitCub.app"), bundle, { recursive: true })
      await exec("/usr/libexec/PlistBuddy", [
        "-c",
        "Set :CFBundleIdentifier day.dreamer.gitcub.conformance",
        join(bundle, "Contents/Info.plist")
      ])
      executable = join(bundle, "Contents/MacOS/gitcub")
    }
    app = spawn(executable, [], {
      cwd: root,
      env: {
        ...process.env,
        TAURI_HASGARD_SOCKET: socket,
        // Keep the native window off the developer's main screen; override with a display index or name.
        TAURI_HASGARD_DISPLAY: process.env.TAURI_HASGARD_DISPLAY ?? "secondary",
        GITCUB_TEST_DATA_DIR: directory,
        GITCUB_TEST_DESKTOP_PROFILE: desktopProfile,
        GITCUB_TEST_UPDATE_ENDPOINT: mockServer.url
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    app.stdout?.on("data", data => output.push(data.toString()))
    app.stderr?.on("data", data => output.push(data.toString()))
    app.once("close", () => {
      void writeFile(join(artifacts, "native.log"), output.join(""))
    })
    await poll(
      async () => {
        if (app.exitCode !== null || app.signalCode !== null) throw new Error(`Tauri exited: ${output.join("")}`)
        return hasgard("ping")
      },
      result => assert.ok(result),
      30_000,
      250
    )
  },
  { timeout: 45_000 }
)

afterEach(async context => {
  if (app?.exitCode === null && app.signalCode === null) {
    const html = String(await hasgard("html").catch(String))
    await writeFile(join(artifacts, "failure.html"), html)
    await writeFile(join(artifacts, `${context.name.replaceAll(/[^a-z0-9]+/gi, "-")}.html`), html)
    await capture(join(artifacts, "failure.png")).catch(() => {})
    const logs = await hasgard<{ args?: unknown[] }[]>("logs")
    await writeFile(join(artifacts, "console.json"), JSON.stringify(logs, null, 2))
    // GitCub integration guard, additional to the immutable upstream assertions:
    // a successful commit must not hide a disconnected production store.
    assert.equal(
      logs.some((entry: { args?: unknown[] }) =>
        String(entry.args?.[0]).includes("Unable to synchronize repository stores")
      ),
      false,
      "The production repository coordinator failed in the real WebView"
    )
  }
})
after(async () => {
  await writeFile(join(artifacts, "commands.json"), JSON.stringify(trace, null, 2))
  if (app?.exitCode === null && app.signalCode === null) {
    app.kill("SIGTERM")
    await new Promise<void>(resolve => app.once("close", () => resolve()))
  }
  await mockServer?.close()
})
