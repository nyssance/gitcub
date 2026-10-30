// Application benchmark: cold start to first paint and resident memory, for the packaged GitCub
// and, when it is installed, GitHub Desktop, driven the same way on the same repository.
//
//   bun run bench:app [--launches 5] [--app <GitCub.app>] [--repo <path>] [--no-desktop] [--settle 3000]
//
// Readiness is Desktop's own E2E definition (`tests/conformance/upstream/desktop/e2e/app-launch-test.ts`): the React root
// `#desktop-app-container` has rendered, read through tauri-hasgard for GitCub and through the
// Chrome DevTools protocol for Desktop. Memory is the RSS of the process tree summed with
// `ps -axo pid,ppid,rss,comm`: the main process and its descendants, plus the WebKit XPC helpers
// that appeared with GitCub (launchd starts them, so they are not its children). Both apps run on
// a fresh profile and get the same repository; nothing of the developer's own data is touched.
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import { machine } from "./bench-machine.ts"
import { createSyntheticRepository } from "./synthetic-repository.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const desktopBundle = "/Applications/GitHub Desktop.app"
const readyExpression = "(document.getElementById('desktop-app-container')?.innerHTML.length ?? 0) > 100"

interface Options {
  launches: number
  app: string | null
  repo: string | null
  desktop: boolean
  settle: number
  files: number
  commits: number
}

interface Sample {
  /** Process spawn → `#desktop-app-container` rendered (first ready paint of the React app). */
  readyMs: number
  /** Process spawn → the first normal window on screen (CGWindowList); polled, about 50 ms resolution. */
  windowMs: number | null
  /** RSS sum of the process tree `settle` ms after ready, in KiB. */
  rssReadyKiB: number
  /** Opening the repository: request → changes list rendered with every change counted. */
  repositoryMs: number
  changes: number
  /** RSS sum `settle` ms after the changes list rendered, in KiB. */
  rssRepositoryKiB: number
  processes: {
    ready: Array<{ pid: number; rssKiB: number; command: string; helper: boolean }>
    repository: Array<{ pid: number; rssKiB: number; command: string; helper: boolean }>
  }
}

function parseArguments(argv: string[]): Options {
  const options: Options = {
    launches: 5,
    app: null,
    repo: null,
    desktop: true,
    settle: 3000,
    files: 50_000,
    commits: 200
  }
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!
    const text = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${argument} needs a value`)
      return next
    }
    const integer = () => {
      const parsed = Number(text())
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${argument} needs a non-negative integer`)
      return parsed
    }
    switch (argument) {
      case "--launches":
        options.launches = integer()
        if (options.launches < 1) throw new Error("--launches needs at least 1")
        break
      case "--app":
        options.app = text()
        break
      case "--repo":
        options.repo = text()
        break
      case "--no-desktop":
        options.desktop = false
        break
      case "--settle":
        options.settle = integer()
        break
      case "--files":
        options.files = integer()
        break
      case "--commits":
        options.commits = integer()
        break
      default:
        throw new Error(`Unknown option: ${argument}`)
    }
  }
  return options
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function exec(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  return { stdout, stderr, exitCode }
}

/** Every process as `ps` lists it: pid, parent pid, RSS in KiB and the command path. */
async function processes() {
  const { stdout } = await exec(["ps", "-axo", "pid=,ppid=,rss=,comm="])
  const rows: Array<{ pid: number; ppid: number; rssKiB: number; command: string }> = []
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match)
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4]! })
  }
  return rows
}

const isWebKitHelper = (command: string) => command.includes("/com.apple.WebKit.")

async function webKitHelperPids() {
  return new Set((await processes()).filter(row => isWebKitHelper(row.command)).map(row => row.pid))
}

/** The main process, its descendants and, when `helpersBefore` is given, the WebKit XPC helpers that were not running before launch. */
async function processTree(pid: number, helpersBefore: Set<number> | null) {
  const rows = await processes()
  const tree = new Set([pid])
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid)
        grew = true
      }
    }
  }
  return rows
    .filter(
      row => tree.has(row.pid) || (helpersBefore !== null && isWebKitHelper(row.command) && !helpersBefore.has(row.pid))
    )
    .map(row => ({
      pid: row.pid,
      rssKiB: row.rssKiB,
      command: basename(row.command),
      helper: isWebKitHelper(row.command)
    }))
}

/** WebKit XPC helpers are launchd children, not the app's; only those that exit together with the app are its own.
 *  Call after the app has been terminated. */
async function ownProcesses<T extends { pid: number; helper: boolean }>(tree: T[]) {
  const alive = new Set((await processes()).map(row => row.pid))
  return tree.filter(row => !(row.helper && alive.has(row.pid)))
}

const sum = (tree: Array<{ rssKiB: number }>) => tree.reduce((total, row) => total + row.rssKiB, 0)

// On-screen windows straight from the window server (CGWindowList): System Events' accessibility
// view of a process that was first queried before its window existed reported 0 windows for the
// rest of the run, and needs the Accessibility permission besides.
const windowScript =
  "ObjC.import('CoreGraphics'); function run(argv) { const pid = Number(argv[0]); const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))); return JSON.stringify(list.filter(w => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0).map(w => w.kCGWindowBounds)) }"

/** Bounds of the process's normal on-screen windows, in global top-left display coordinates. */
async function onScreenWindows(pid: number) {
  const { stdout } = await exec(["osascript", "-l", "JavaScript", "-e", windowScript, String(pid)])
  try {
    return JSON.parse(stdout.trim() || "[]") as Array<{ X: number; Y: number; Width: number; Height: number }>
  } catch {
    return []
  }
}

/** The first display that is not the primary one, in System Events coordinates (top-left origin). */
async function secondaryDisplay() {
  const { stdout } = await exec([
    "osascript",
    "-l",
    "JavaScript",
    "-e",
    'ObjC.import("AppKit"); const screens = $.NSScreen.screens; const out = []; for (let i = 0; i < screens.count; i++) { const f = screens.objectAtIndex(i).frame; out.push([f.origin.x, f.origin.y, f.size.width, f.size.height]) } JSON.stringify(out)'
  ])
  const screens = JSON.parse(stdout.trim() || "[]") as number[][]
  const primary = screens[0]
  const secondary = screens[1]
  if (!primary || !secondary) return null
  // Cocoa frames grow upwards from the primary display's bottom-left corner; System Events counts from its top-left.
  return {
    x: secondary[0]!,
    y: primary[3]! - (secondary[1]! + secondary[3]!),
    width: secondary[2]!,
    height: secondary[3]!
  }
}

/** Moves the main window's top-left corner onto the secondary display; the window server then keeps it below that display's menu bar. */
async function moveWindowToSecondaryDisplay(pid: number) {
  const display = await secondaryDisplay()
  if (!display) return false
  const inside = (window: { X: number; Y: number }) =>
    window.X >= display.x &&
    window.X < display.x + display.width &&
    window.Y >= display.y &&
    window.Y < display.y + display.height
  for (let attempt = 0; attempt < 10; attempt++) {
    if ((await onScreenWindows(pid)).some(inside)) return true
    await exec([
      "osascript",
      "-e",
      `tell application "System Events" to set position of first window of (first process whose unix id is ${pid}) to {${display.x}, ${display.y}}`
    ])
    await sleep(300)
  }
  return (await onScreenWindows(pid)).some(inside)
}

function waitForWindow(pid: number, started: number, stop: { done: boolean }) {
  return (async () => {
    while (!stop.done) {
      if ((await onScreenWindows(pid)).length > 0) return performance.now() - started
      await sleep(50)
    }
    return null
  })()
}

async function until<T>(
  get: () => Promise<T>,
  check: (value: T) => boolean,
  seconds: number,
  step: string,
  interval = 25
) {
  const deadline = Date.now() + seconds * 1000
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await get()
    if (check(last)) return last
    await sleep(interval)
  }
  throw new Error(`${step}: deadline exceeded after ${seconds} seconds; last value ${JSON.stringify(last)}`)
}

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
  await Promise.race([exited, sleep(5000)])
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
}

const gitConfig = (directory: string) => {
  const config = join(directory, "gitconfig")
  writeFileSync(
    config,
    "[user]\nname = Benchmark\nemail = benchmark@example.invalid\n[commit]\ngpgsign = false\n[core]\nhooksPath = /dev/null\n"
  )
  return config
}

// ── GitCub ──────────────────────────────────────────────────────────────────

async function hasgard(socket: string, expression: string) {
  const { stdout, exitCode } = await exec(["tauri-hasgard", "--socket", socket, "--json", "eval", expression])
  if (exitCode !== 0) throw new Error("hasgard unavailable")
  const result = JSON.parse(stdout) as { error?: unknown }
  if (result && typeof result === "object" && "error" in result) throw new Error(JSON.stringify(result.error))
  return result as unknown
}

const gitcubChangesExpression = `(() => {
  const container = document.querySelector('.changes-list-container');
  if (!container) return -1;
  const span = [...container.querySelectorAll('span[title]')].find(el => /^\\d+\\/\\d+$/.test(el.textContent.trim()));
  return span ? Number(span.textContent.trim().split('/')[1]) : 0;
})()`

async function launchGitCub(bundle: string, repository: string, settle: number): Promise<Sample> {
  const directory = mkdtempSync(join(tmpdir(), "gitcub-bench-app-"))
  const socket = join(directory, "hasgard.sock")
  // The state GitCub restores on start: this one repository selected, the Desktop import already answered.
  writeFileSync(
    join(directory, "state.json"),
    JSON.stringify({
      repositories: [repository],
      selectedRepository: repository,
      repoOwnership: { [repository]: "mine" },
      desktopImportHandled: true
    })
  )
  const helpersBefore = await webKitHelperPids()
  const started = performance.now()
  const child = spawn(join(bundle, "Contents/MacOS/gitcub"), [], {
    env: {
      ...process.env,
      TAURI_HASGARD_SOCKET: socket,
      TAURI_HASGARD_DISPLAY: process.env.TAURI_HASGARD_DISPLAY ?? "secondary",
      GITCUB_TEST_DATA_DIR: directory,
      GIT_CONFIG_GLOBAL: gitConfig(directory),
      GIT_CONFIG_NOSYSTEM: "1"
    },
    stdio: "ignore"
  })
  const stop = { done: false }
  const window = waitForWindow(child.pid!, started, stop)
  let sample: {
    readyMs: number
    windowMs: number | null
    repositoryMs: number
    changes: number
    ready: Awaited<ReturnType<typeof processTree>>
    afterRepository: Awaited<ReturnType<typeof processTree>>
  }
  try {
    await until(
      () => hasgard(socket, readyExpression).catch(() => false),
      ready => ready === true,
      60,
      "GitCub ready"
    )
    const readyMs = performance.now() - started
    const windowMs = await Promise.race([window, sleep(5000).then(() => null)])
    stop.done = true
    await sleep(settle)
    const ready = await processTree(child.pid!, helpersBefore)
    // The fresh profile shows the welcome flow; mark it complete and reload like a returning user whose
    // last selected repository is this one (tests/macos/live-account-errors.ts does the same).
    const opened = performance.now()
    await hasgard(
      socket,
      "(() => { localStorage.setItem('has-shown-welcome-flow', '1'); location.reload(); return true })()"
    )
    await sleep(500)
    const changes = await until(
      () => hasgard(socket, gitcubChangesExpression).catch(() => -1) as Promise<number>,
      count => count >= 0,
      120,
      "GitCub changes list"
    )
    const repositoryMs = performance.now() - opened
    await sleep(settle)
    const afterRepository = await processTree(child.pid!, helpersBefore)
    sample = { readyMs, windowMs, repositoryMs, changes, ready, afterRepository }
  } finally {
    stop.done = true
    await terminate(child)
    rmSync(directory, { recursive: true, force: true })
  }
  await sleep(1000)
  const readyTree = await ownProcesses(sample.ready)
  const repositoryTree = await ownProcesses(sample.afterRepository)
  return {
    readyMs: sample.readyMs,
    windowMs: sample.windowMs,
    rssReadyKiB: sum(readyTree),
    repositoryMs: sample.repositoryMs,
    changes: sample.changes,
    rssRepositoryKiB: sum(repositoryTree),
    processes: { ready: readyTree, repository: repositoryTree }
  }
}

// ── GitHub Desktop ──────────────────────────────────────────────────────────

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** One page of the Chrome DevTools protocol: `Runtime.evaluate` with the value returned. */
class DevTools {
  private socket: WebSocket | null = null
  private id = 0
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  constructor(private readonly port: number) {}

  private async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket
    const response = await fetch(`http://127.0.0.1:${this.port}/json`)
    const pages = (await response.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>
    const page =
      pages.find(page => page.type === "page" && page.url.includes("index.html")) ??
      pages.find(page => page.type === "page")
    if (!page) throw new Error("no page yet")
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("DevTools socket failed"))
    })
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        result?: { result?: { value?: unknown }; exceptionDetails?: unknown }
      }
      if (message.id === undefined) return
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.result?.exceptionDetails) waiter.reject(new Error(JSON.stringify(message.result.exceptionDetails)))
      else waiter.resolve(message.result?.result?.value)
    }
    socket.onclose = () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("DevTools socket closed"))
      this.pending.clear()
      this.socket = null
    }
    this.socket = socket
    return socket
  }

  async evaluate(expression: string) {
    const socket = await this.connect()
    const id = ++this.id
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }))
    })
  }

  close() {
    this.socket?.close()
  }
}

// The list's group label (`filter-changes-list.tsx` getListAriaLabel: "603 changed files") counts
// every change, rows only the ones rendered.
const desktopChangesExpression = `(() => {
  const group = document.querySelector('.changes-list-container [aria-label*="changed file"], [aria-label*="changed file"]');
  const label = group && group.getAttribute('aria-label');
  const match = label && label.match(/\\d[\\d,]*/);
  if (match) return Number(match[0].replace(/,/g, ''));
  if (!document.querySelector('.changes-list-container')) return -1;
  return document.querySelectorAll('.changes-list-container .list-item').length;
})()`

async function launchDesktop(repository: string, settle: number): Promise<Sample> {
  const directory = mkdtempSync(join(tmpdir(), "github-desktop-bench-app-"))
  const profile = join(directory, "profile")
  mkdirSync(profile)
  const port = await freePort()
  // Electron's helpers are children of the main process; nothing of Desktop's runs under launchd.
  const helpersBefore = null
  const started = performance.now()
  // `--user-data-dir` gives this instance its own profile and single-instance lock, so a GitHub
  // Desktop the developer already has open keeps running untouched and this one starts from scratch.
  const child = spawn(
    join(desktopBundle, "Contents/MacOS/GitHub Desktop"),
    [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
    { env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig(directory), GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" }
  )
  const stop = { done: false }
  const window = waitForWindow(child.pid!, started, stop)
  const devtools = new DevTools(port)
  try {
    await until(
      () => devtools.evaluate(readyExpression).catch(() => false),
      ready => ready === true,
      60,
      "Desktop ready"
    )
    const readyMs = performance.now() - started
    const windowMs = await Promise.race([window, sleep(5000).then(() => null)])
    stop.done = true
    if (!(await moveWindowToSecondaryDisplay(child.pid!)))
      console.warn("GitHub Desktop window stayed on the primary display")
    await sleep(settle)
    const ready = await processTree(child.pid!, helpersBefore)
    // Desktop ignores `location.reload()`, so the welcome flow is finished the way its E2E test does
    // (`tests/conformance/upstream/desktop/e2e/app-launch-test.ts`): the "Skip this step" link, then "Finish" on the identity
    // form, which GIT_CONFIG_GLOBAL has already filled in. DOM clicks only, no keystrokes.
    await until(
      () =>
        devtools
          .evaluate(
            `(() => {
            const skip = document.querySelector('#welcome a.skip-button');
            if (skip) skip.click();
            const finish = [...document.querySelectorAll('#welcome button')].find(button => button.textContent.trim() === 'Finish');
            if (finish) finish.click();
            return !document.querySelector('#welcome');
          })()`
          )
          .catch(() => false),
      done => done === true,
      60,
      "Desktop welcome flow",
      200
    )
    // What `github <path>` does: the main process relays `--cli-open=<path>` as a `cli-action`
    // (`app/src/main-process/main.ts` handleCLIAction → `app/src/ui/index.tsx` ipcRenderer.on('cli-action')).
    // Emitting it on the renderer side, as Desktop's own E2E tests do for menu events, opens the
    // Add Repository dialog with the path filled in; its submit button is clicked in the DOM.
    const opened = performance.now()
    await devtools.evaluate(
      `(() => { require('electron').ipcRenderer.emit('cli-action', {}, { kind: 'open-repository', path: ${JSON.stringify(repository)} }); return true })()`
    )
    await until(
      () => devtools.evaluate("!!document.querySelector('#add-existing-repository')").catch(() => false),
      shown => shown === true,
      60,
      "Desktop add repository dialog",
      100
    )
    await until(
      () =>
        devtools
          .evaluate(
            `(() => {
          const button = document.querySelector('#add-existing-repository button[type="submit"]');
          if (button && !button.disabled) button.click();
          return !document.querySelector('#add-existing-repository');
        })()`
          )
          .catch(() => false),
      closed => closed === true,
      60,
      "Desktop add repository dialog",
      200
    )
    const changes = await until(
      () => devtools.evaluate(desktopChangesExpression).catch(() => -1) as Promise<number>,
      count => count >= 0,
      120,
      "Desktop changes list"
    )
    const repositoryMs = performance.now() - opened
    await sleep(settle)
    const afterRepository = await processTree(child.pid!, helpersBefore)
    return {
      readyMs,
      windowMs,
      rssReadyKiB: sum(ready),
      repositoryMs,
      changes,
      rssRepositoryKiB: sum(afterRepository),
      processes: { ready, repository: afterRepository }
    }
  } finally {
    stop.done = true
    devtools.close()
    await terminate(child)
    rmSync(directory, { recursive: true, force: true })
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function summarize(samples: Sample[]) {
  const windows = samples.map(sample => sample.windowMs).filter((value): value is number => value !== null)
  return {
    readyMs: median(samples.map(sample => sample.readyMs)),
    windowMs: windows.length ? median(windows) : null,
    rssReadyKiB: median(samples.map(sample => sample.rssReadyKiB)),
    repositoryMs: median(samples.map(sample => sample.repositoryMs)),
    rssRepositoryKiB: median(samples.map(sample => sample.rssRepositoryKiB)),
    changes: samples[0]?.changes ?? 0
  }
}

if (process.platform !== "darwin") throw new Error("macOS is required")
const options = parseArguments(process.argv.slice(2))
if (Bun.spawnSync(["tauri-hasgard", "--version"]).exitCode !== 0)
  throw new Error("Install the E2E driver with: cargo install tauri-hasgard-cli --version '^0.6' --locked")
// tauri-plugin-hasgard is a no-op outside debug builds, so the driven bundle is the one
// `scripts/prepare-e2e.ts` makes: Rust debug profile with the `hasgard-testing` feature.
const bundle = options.app ?? join(root, "src-tauri/target/debug/bundle/macos/GitCub.app")
if (!existsSync(join(bundle, "Contents/MacOS/gitcub")))
  throw new Error("No GitCub.app with the hasgard-testing feature; build one with bun scripts/prepare-e2e.ts")
const desktopInstalled = existsSync(join(desktopBundle, "Contents/MacOS/GitHub Desktop"))
const compareDesktop = options.desktop && desktopInstalled

console.warn(
  "Warning: each launch activates the application and briefly takes keyboard focus; windows are placed on the secondary display (TAURI_HASGARD_DISPLAY for GitCub, System Events for Desktop). No keystrokes are injected."
)
console.log(`GitCub bundle: ${bundle} (${bundle.includes("/release/") ? "release" : "debug"} profile)`)
console.log(
  compareDesktop
    ? `GitHub Desktop: ${desktopBundle}`
    : desktopInstalled
      ? "GitHub Desktop: installed, skipped (--no-desktop)"
      : "GitHub Desktop: not installed, no comparison"
)

const temporary = mkdtempSync(join(tmpdir(), "gitcub-bench-app-repo-"))
// Spotlight skips `*.noindex` directories, so indexing 50 000 fresh files does not compete with the launches.
const scratch = join(temporary, "repos.noindex")
mkdirSync(scratch)
const gitcub: Sample[] = []
const desktop: Sample[] = []
try {
  let repository = options.repo
  if (!repository) {
    repository = join(scratch, `synthetic-${options.files}-files`)
    console.log(`Preparing ${repository} (${options.files} files, ${options.commits} commits)…`)
    createSyntheticRepository(repository, options.files, options.commits)
  }
  for (let launch = 1; launch <= options.launches; launch++) {
    console.log(`Launch ${launch}/${options.launches}: GitCub…`)
    gitcub.push(await launchGitCub(bundle, repository, options.settle))
    await sleep(1000)
    if (compareDesktop) {
      console.log(`Launch ${launch}/${options.launches}: GitHub Desktop…`)
      desktop.push(await launchDesktop(repository, options.settle))
      await sleep(1000)
    }
  }
  const summary = { gitcub: summarize(gitcub), desktop: compareDesktop ? summarize(desktop) : null }
  const mib = (kib: number) => (kib / 1024).toFixed(0)
  const row = (name: string, s: ReturnType<typeof summarize>) =>
    `| ${name} | ${s.readyMs.toFixed(0)} | ${s.windowMs === null ? "—" : s.windowMs.toFixed(0)} | ${mib(s.rssReadyKiB)} | ${s.repositoryMs.toFixed(0)} | ${mib(s.rssRepositoryKiB)} |`
  console.log("")
  console.log("| 应用 | 启动到就绪 (ms) | 启动到窗口 (ms) | 就绪后 RSS (MiB) | 打开仓库 (ms) | 打开仓库后 RSS (MiB) |")
  console.log("|---|---:|---:|---:|---:|---:|")
  console.log(row("GitCub", summary.gitcub))
  if (summary.desktop) console.log(row("GitHub Desktop", summary.desktop))

  const directory = join(root, "test-results/benchmark")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, "app.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scope:
          "readyMs: process spawn → #desktop-app-container rendered; windowMs: spawn → first normal window on screen per CGWindowList (~50 ms resolution); rssKiB: ps RSS summed over the main process, its descendants and the WebKit XPC helpers that appeared with GitCub.",
        machine: machine(),
        options: { ...options, app: bundle, repo: repository },
        gitcubProfile: bundle.includes("/release/") ? "release" : "debug",
        desktop: compareDesktop ? desktopBundle : null,
        summary,
        gitcub,
        desktopSamples: desktop
      },
      null,
      2
    )}\n`
  )
  console.log(`\nReport written to ${join(directory, "app.json")}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
