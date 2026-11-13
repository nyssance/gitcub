// Application benchmark: cold start to first paint and resident memory, for the packaged GitCub
// and, when it is installed, GitHub Desktop, driven the same way on the same repository.
//
//   bun run bench:app [--launches 5] [--app <GitCub.app>] [--repo <path>] [--no-desktop] [--settle 3000]
//                     [--heap-snapshot <dir>]
//
// Readiness is Desktop's own E2E definition (`tests/conformance/upstream/desktop/e2e/app-launch-test.ts`): the React root
// `#desktop-app-container` has rendered, read through tauri-hasgard for GitCub and through the
// Chrome DevTools protocol for Desktop. Memory is the RSS of the process tree summed with
// `ps -axo pid,ppid,rss,comm`: the main process and its descendants, plus the WebKit XPC helpers
// that appeared with GitCub (launchd starts them, so they are not its children). Both apps run on
// a fresh profile and get the same repository; nothing of the developer's own data is touched.
import { type ChildProcess, spawn } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
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
  /** Working-tree changes made in the synthetic repository: half modified tracked files, half new untracked ones. */
  dirty: number
  /** Lines added to the tracked `1-bench-diff.txt` whose diff is timed (synthetic repository only; 0 skips it). */
  diffLines: number
  /** Directory for GitCub JavaScript heap snapshots (tauri-hasgard `heap-snapshot`), taken after each memory sample of
   *  the first launch: `ready.heap.json` and `repository.heap.json`. Null skips them. */
  heapSnapshot: string | null
}

interface Sample {
  /** Process spawn → `#desktop-app-container` rendered (first ready paint of the React app). */
  readyMs: number
  /** Process spawn → the first normal window on screen (CGWindowList); polled, about 50 ms resolution. */
  windowMs: number | null
  /** RSS sum of the process tree `settle` ms after ready, in KiB. */
  rssReadyKiB: number
  /** Opening the repository → changes list showing every change. Desktop: submit click in the Add Local Repository
   *  dialog; GitCub: click on it in the repository rail, coming from a small repository (no picker to drive). */
  repositoryMs: number
  changes: number
  /** RSS sum `settle` ms after the changes list rendered, in KiB. */
  rssRepositoryKiB: number
  /** Top-level git processes GitCub spawned (GIT_TRACE2_EVENT): from launch until `settle` ms after the
   *  repository opened, then over another `settle` ms of idling; with their subcommands. */
  gitProcesses?: { repository: number; idle: number; commands: Record<string, number>; argv: string[][] }
  /** Click on `0-bench-diff.txt` in the changes list → its first line shown in the diff; then scrolling the diff to
   *  the end → its last line shown. Timed inside the page like repositoryMs. Null when the probe is skipped. */
  diff: { openMs: number; scrollMs: number } | null
  /** RSS sum `settle` ms after the diff was scrolled to the end, in KiB. */
  rssDiffKiB: number | null
  /** The same three moments as phys_footprint sums (`footprint`, what Activity Monitor calls Memory): unlike RSS it
   *  counts compressed pages and leaves shared framework pages out, so memory pressure does not make a side look small. */
  footprintKiB: { ready: number; repository: number; diff: number | null }
  processes: {
    ready: Array<{ pid: number; rssKiB: number; footprintKiB: number; command: string; helper: boolean }>
    repository: Array<{ pid: number; rssKiB: number; footprintKiB: number; command: string; helper: boolean }>
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
    commits: 200,
    dirty: 0,
    diffLines: 5000,
    heapSnapshot: null
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
      case "--heap-snapshot":
        options.heapSnapshot = text()
        mkdirSync(options.heapSnapshot, { recursive: true })
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
      case "--diff-lines":
        options.diffLines = integer()
        break
      case "--dirty":
        options.dirty = integer()
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
  const own = rows.filter(
    row => tree.has(row.pid) || (helpersBefore !== null && isWebKitHelper(row.command) && !helpersBefore.has(row.pid))
  )
  const footprints = footprint(own.map(row => row.pid))
  return own.map(row => ({
    pid: row.pid,
    rssKiB: row.rssKiB,
    footprintKiB: footprints.get(row.pid) ?? 0,
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
const footprintSum = (tree: Array<{ footprintKiB: number }>) => tree.reduce((total, row) => total + row.footprintKiB, 0)

/** phys_footprint per pid in KiB, from one `footprint` run over all of them (no root needed for the user's own processes). */
function footprint(pids: number[]) {
  const result = new Map<number, number>()
  if (pids.length === 0) return result
  const file = join(mkdtempSync(join(tmpdir(), "gitcub-bench-footprint-")), "footprint.json")
  try {
    Bun.spawnSync(["footprint", "-f", "bytes", "-j", file, ...pids.flatMap(pid => ["-p", String(pid)])])
    const report = JSON.parse(readFileSync(file, "utf8")) as { processes: Array<{ pid: number; footprint: number }> }
    for (const entry of report.processes) result.set(entry.pid, entry.footprint / 1024)
  } catch (error) {
    console.warn(`footprint failed: ${String(error)}`)
  } finally {
    rmSync(dirname(file), { recursive: true, force: true })
  }
  return result
}

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

const gitConfig = (directory: string, name = "gitconfig") => {
  const config = join(directory, name)
  writeFileSync(
    config,
    "[user]\nname = Benchmark\nemail = benchmark@example.invalid\n[commit]\ngpgsign = false\n[core]\nhooksPath = /dev/null\n"
  )
  return config
}

// ── GitCub ──────────────────────────────────────────────────────────────────

// The engine collects garbage before building the snapshot, so it holds live objects only.
async function writeHeapSnapshot(socket: string, output: string) {
  const { stdout, exitCode } = await exec([
    "tauri-hasgard",
    "--socket",
    socket,
    "--json",
    "heap-snapshot",
    "--output",
    resolve(output)
  ])
  if (exitCode !== 0) throw new Error(`heap-snapshot failed: ${stdout}`)
  console.log(`Heap snapshot: ${output}`)
}

async function hasgard(socket: string, expression: string) {
  const { stdout, exitCode } = await exec(["tauri-hasgard", "--socket", socket, "--json", "eval", expression])
  if (exitCode !== 0) throw new Error("hasgard unavailable")
  const result = JSON.parse(stdout) as { error?: unknown }
  if (result && typeof result === "object" && "error" in result) throw new Error(JSON.stringify(result.error))
  return result as unknown
}

// Both apps' `add-existing-repository` dialog: the clock starts at the submit click, once validation has enabled it.
const submitEnabledExpression = `(() => {
  const button = document.querySelector('#add-existing-repository button[type="submit"]');
  return !!button && !button.disabled;
})()`

// Timed inside the page on both sides: from the click to the DOM mutation that makes the list show every change.
// Polling from outside costs differently per app (a hasgard process per poll against one DevTools socket), so it
// only collects the result.
const armExpression = (count: string, expected: number) => `(() => {
  // One clock at a time: an earlier observer whose condition still holds would stop this one at the first mutation.
  window.__benchObserver?.disconnect();
  window.__benchStart = null;
  window.__benchDone = null;
  const check = () => {
    if (window.__benchStart === null || window.__benchDone !== null) return;
    const value = ${count};
    if (value === ${expected}) window.__benchDone = [performance.now() - window.__benchStart, value];
  };
  window.__benchObserver = new MutationObserver(check);
  window.__benchObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  return true;
})()`
const clickExpression = (click: string) =>
  `(() => { window.__benchStart = performance.now(); ${click}; return true })()`
const finishedExpression = "window.__benchDone"

// The diff probe: both apps list changes in `.changes-list-container` and draw the selected file's diff in
// `.diff-container` (Desktop changes/changes.tsx, GitCub ui/diff/diff.tsx); both virtualize the diff rows.
// Both apps select the first changed file when the repository opens, so a small tracked change sorts first and the
// probe second: its diff loads only on the timed click.
const firstChange = "0-first.txt"
const diffProbe = "1-bench-diff.txt"
const diffLine = (n: number) => `bench diff line ${n}`
const diffShowsExpression = (text: string) =>
  `(document.querySelector('.diff-container')?.textContent ?? '').includes(${JSON.stringify(text)}) ? 1 : 0`
const diffRowExpression = `(() => {
  const list = document.querySelector('.changes-list-container');
  // GitCub's rows carry the path as a title (its label splits name and directory); Desktop's leaf holds the name.
  const label = list && ([...list.querySelectorAll('[title]')].find(el => el.getAttribute('title') === ${JSON.stringify(diffProbe)})
    ?? [...list.querySelectorAll('*')].find(el => el.childElementCount === 0 && el.textContent.trim() === ${JSON.stringify(diffProbe)}));
  return label ? (label.closest('[role="option"]') ?? label) : null;
})()`
const clickDiffRow = `(() => {
  const row = ${diffRowExpression};
  for (const type of ['mousedown', 'mouseup', 'click']) row.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
})()`
// The scrollable element under the diff with the most to scroll: Desktop's react-virtualized grid, GitCub's viewport.
const scrollDiffToEnd = `(() => {
  const scrollers = [...document.querySelectorAll('.diff-container *')].filter(el => el.scrollHeight > el.clientHeight + 1);
  const target = scrollers.toSorted((a, b) => b.scrollHeight - a.scrollHeight)[0];
  target.scrollTop = target.scrollHeight;
  target.dispatchEvent(new Event('scroll'));
})()`

// Splits the jump to the end: how long the synchronous scroll dispatch takes, and how much of it is layout forced
// by reads of geometry (the virtualizers measure rows as they mount). Counts and time are per read API.
const installLayoutProbe = `(() => {
  const probe = (window.__benchLayout = { reads: 0, ms: 0, slowest: 0, by: {} });
  const wrap = (proto, name, kind) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor) return;
    const original = kind === 'get' ? descriptor.get : descriptor.value;
    const timed = function (...args) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally {
        const took = performance.now() - start;
        probe.reads++; probe.ms += took; probe.slowest = Math.max(probe.slowest, took);
        const entry = (probe.by[name] ??= { reads: 0, ms: 0 }); entry.reads++; entry.ms += took;
      }
    };
    Object.defineProperty(proto, name, kind === 'get' ? { ...descriptor, get: timed } : { ...descriptor, value: timed });
  };
  wrap(Element.prototype, 'getBoundingClientRect', 'value');
  for (const name of ['scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight', 'scrollTop']) wrap(Element.prototype, name, 'get');
  for (const name of ['offsetWidth', 'offsetHeight', 'offsetTop']) wrap(HTMLElement.prototype, name, 'get');
  wrap(window, 'getComputedStyle', 'value');
  return true;
})()`
const profiledScrollDiffToEnd = `(() => {
  const scrollers = [...document.querySelectorAll('.diff-container *')].filter(el => el.scrollHeight > el.clientHeight + 1);
  const target = scrollers.toSorted((a, b) => b.scrollHeight - a.scrollHeight)[0];
  const probe = window.__benchLayout;
  probe.reads = 0; probe.ms = 0; probe.slowest = 0; probe.by = {};
  const rowsBefore = document.querySelectorAll('.diff-container [role=row], .diff-container .row').length;
  const start = performance.now();
  target.scrollTop = target.scrollHeight;
  target.dispatchEvent(new Event('scroll'));
  const dispatchMs = performance.now() - start;
  const inDispatch = JSON.parse(JSON.stringify(probe));
  const layoutStart = performance.now();
  void document.body.offsetHeight;
  window.__benchScrollProfile = { dispatchMs, inDispatch, layoutAfterMs: performance.now() - layoutStart, rowsBefore,
    rowsAfter: document.querySelectorAll('.diff-container [role=row], .diff-container .row').length };
  // The last line showing is not the viewport being drawn: time until as many rows are back as before the jump.
  const count = () => document.querySelectorAll('.diff-container [role=row], .diff-container .row').length;
  const filled = () => {
    if (count() >= rowsBefore * 0.8) {
      window.__benchScrollProfile.filledMs = performance.now() - start;
      window.__benchScrollProfile.rowsFilled = count();
      observer.disconnect();
    }
  };
  const observer = new MutationObserver(filled);
  observer.observe(target, { subtree: true, childList: true });
  filled();
})()`

// Continuous scrolling, one fixed step at a time. Each step is timed on the main thread: the synchronous scroll
// dispatch (the virtualizer rendering the rows that came into view) plus the layout it leaves pending, forced right
// after. That sum is what has to fit in a refresh period for the scroll to keep up. Steps are driven by animation
// frames when the page is visible, which also gives the interval between frames; a window that is occluded or parked
// by Stage Manager gets no animation frames at all, so there the steps run off a MessageChannel and only the per-step
// cost is reported.
const scrollFrames = (frames: number, step: number) => `(() => {
  const scrollers = [...document.querySelectorAll('.diff-container *')].filter(el => el.scrollHeight > el.clientHeight + 1);
  const target = scrollers.toSorted((a, b) => b.scrollHeight - a.scrollHeight)[0];
  const count = () => document.querySelectorAll('.diff-container [role=row], .diff-container .row').length;
  const rowsBefore = count();
  const visible = document.visibilityState === 'visible';
  const intervals = [], dispatch = [], layout = [], rows = [];
  let last = null, left = ${frames};
  const channel = new MessageChannel();
  const next = () => (visible ? requestAnimationFrame(frame) : channel.port2.postMessage(0));
  const frame = () => {
    const now = performance.now();
    if (last !== null) intervals.push(now - last);
    last = now;
    if (left-- === 0) {
      window.__benchScrollFrames = { visible, rowsBefore, intervals, dispatch, layout, rows };
      return;
    }
    const start = performance.now();
    target.scrollTop += ${step};
    target.dispatchEvent(new Event('scroll'));
    const dispatched = performance.now();
    void document.body.offsetHeight;
    dispatch.push(dispatched - start);
    layout.push(performance.now() - dispatched);
    rows.push(count());
    next();
  };
  channel.port1.onmessage = frame;
  window.__benchScrollFrames = null;
  next();
})()`

interface ScrollFrames {
  steps: number
  /** False when the window got no animation frames (occluded); the intervals are then not frame intervals. */
  visible: boolean
  /** Interval between animation frames, ms; null when not visible. */
  interval: { median: number; p95: number; max: number; dropped: number } | null
  /** Main-thread cost of one step, ms: scroll dispatch plus the forced layout after it. */
  stepMedian: number
  stepP95: number
  stepMax: number
  dispatchMedian: number
  layoutMedian: number
  /** Means: WebKit's clock ticks in whole milliseconds, so only the mean over all steps resolves below 1 ms. */
  dispatchMean: number
  layoutMean: number
  /** Fewest rows mounted right after a step, against the count before scrolling. */
  rowsMin: number
  rowsBefore: number
}

function summarizeFrames(raw: {
  visible: boolean
  rowsBefore: number
  intervals: number[]
  dispatch: number[]
  layout: number[]
  rows: number[]
}): ScrollFrames {
  const at = (values: number[], q: number) =>
    values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!
  const mean = (values: number[]) =>
    Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100
  const steps = raw.dispatch.map((dispatch, index) => dispatch + raw.layout[index]!)
  const period = at(raw.intervals, 0.5)
  return {
    steps: steps.length,
    visible: raw.visible,
    interval: raw.visible
      ? {
          median: period,
          p95: at(raw.intervals, 0.95),
          max: Math.max(...raw.intervals),
          dropped: raw.intervals.filter(interval => interval > period * 1.5).length
        }
      : null,
    stepMedian: at(steps, 0.5),
    stepP95: at(steps, 0.95),
    stepMax: Math.max(...steps),
    dispatchMedian: at(raw.dispatch, 0.5),
    layoutMedian: at(raw.layout, 0.5),
    dispatchMean: mean(raw.dispatch),
    layoutMean: mean(raw.layout),
    rowsMin: Math.min(...raw.rows),
    rowsBefore: raw.rowsBefore
  }
}

/** Opens the probe file's diff and scrolls it to the end, both timed in the page. */
async function measureDiff(evaluate: (expression: string) => Promise<unknown>, lines: number) {
  await until(
    () => evaluate(`!!${diffRowExpression}`).catch(() => false),
    shown => shown === true,
    60,
    "diff probe row",
    100
  )
  const finished = () =>
    until(
      () => evaluate(finishedExpression).catch(() => null) as Promise<[number, number] | null>,
      done => done !== null,
      60,
      "diff probe",
      50
    ).then(done => done![0])
  // The probe must not be on screen yet, or the clock would stop at the next unrelated mutation.
  if ((await evaluate(diffShowsExpression(diffLine(0)))) !== 0) throw new Error(`${diffProbe} was already shown`)
  await evaluate(armExpression(diffShowsExpression(diffLine(0)), 1))
  await evaluate(clickExpression(clickDiffRow))
  const openMs = await finished()
  // Let the first paint settle so the scroll timing does not include the open.
  await sleep(500)
  // BENCH_SCROLL_FRAMES=<steps>: scroll that many steps, BENCH_SCROLL_STEP px each (80), before the jump to the end.
  const frameCount = Number(process.env.BENCH_SCROLL_FRAMES ?? 0)
  if (frameCount > 0) {
    // BENCH_PAGE_CSS=<css>: a stylesheet added before the steps, to try a styling change without rebuilding.
    const css = process.env.BENCH_PAGE_CSS
    if (css)
      await evaluate(
        `document.head.appendChild(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(css)} })) && true`
      )
    await evaluate(clickExpression(scrollFrames(frameCount, Number(process.env.BENCH_SCROLL_STEP ?? 80))))
    const raw = await until(
      () => evaluate("JSON.stringify(window.__benchScrollFrames ?? null)") as Promise<string>,
      value => value !== "null",
      60,
      "scroll frames",
      100
    )
    console.error("scroll frames", JSON.stringify(summarizeFrames(JSON.parse(raw))))
    await sleep(300)
  }
  const profile = process.env.BENCH_SCROLL_PROFILE === "1"
  if (profile) await evaluate(installLayoutProbe)
  await evaluate(armExpression(diffShowsExpression(diffLine(lines - 1)), 1))
  await evaluate(clickExpression(profile ? profiledScrollDiffToEnd : scrollDiffToEnd))
  const scrollMs = await finished()
  if (profile) {
    await sleep(300)
    console.error("scroll profile", JSON.stringify(await evaluate("JSON.stringify(window.__benchScrollProfile)")))
  }
  return { openMs, scrollMs }
}

// The header (`sidebar.tsx`, locales `changes.fileCount` / `fileCountFiltered`) counts every change, rows only the
// ones rendered: "603 changed files", "3 of 603 changed files"; "603 个文件已更改", "603 个中的 3 个".
const gitcubChangesExpression = `(() => {
  const container = document.querySelector('.changes-list-container');
  if (!container) return -1;
  for (const span of container.querySelectorAll('label span')) {
    const text = span.textContent.trim();
    const match = text.match(/(\\d[\\d,]*) changed files?$/) || text.match(/^(\\d[\\d,]*) 个(?:文件已更改|中的)/);
    if (match) return Number(match[1].replace(/,/g, ''));
  }
  return -1;
})()`

async function launchGitCub(
  bundle: string,
  repository: string,
  settle: number,
  expected: number,
  diffLines: number,
  heapSnapshot: string | null
): Promise<Sample> {
  const directory = mkdtempSync(join(tmpdir(), "gitcub-bench-app-"))
  const socket = join(directory, "hasgard.sock")
  // GitCub adds repositories through the system folder picker (`app.tsx` pickRepo), which a script cannot drive, so it is
  // timed switching from a small repository to this one: both listed under "Mine", the small one selected on start.
  // Its untracked count differs from the measured one, so a stale header never satisfies the wait.
  const small = join(directory, "small")
  mkdirSync(small)
  Bun.spawnSync(["git", "-C", small, "init", "-q", "-b", "main"])
  for (let i = 0; i < (expected === 1 ? 2 : 1); i++) writeFileSync(join(small, `untracked-${i}`), "")
  writeFileSync(
    join(directory, "state.json"),
    JSON.stringify({
      repositories: [small, repository],
      selectedRepository: small,
      repoOwnership: { [small]: "mine", [repository]: "mine" },
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
      // Straight into the main window like a returning user (`main.rs` writes the welcome marker before page scripts):
      // a `location.reload()` from the welcome page would leave the first page's heap to the measured one.
      GITCUB_TEST_SKIP_WELCOME: "1",
      // The same isolated identity as ~/.gitconfig of a throwaway HOME: GIT_CONFIG_GLOBAL would make the in-process
      // fast paths defer to git (they cannot prove they read the same file), so the launch would time the fallback.
      HOME: (gitConfig(directory, ".gitconfig"), directory),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TRACE2_EVENT: join(directory, "trace2.json")
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
    git: NonNullable<Sample["gitProcesses"]>
    diff: Sample["diff"]
    afterDiff: Awaited<ReturnType<typeof processTree>> | null
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
    if (heapSnapshot) await writeHeapSnapshot(socket, join(heapSnapshot, "ready.heap.json"))
    const target = `document.querySelector(${JSON.stringify(`button[title="${repository}"]`)})`
    // The rail has one tab per hosting platform and opens on GitHub; a repository without a hosted origin is under
    // the last one ("Other"), whose panel is only mounted once it is selected.
    const showOtherTab = `(() => {
      if (${target}) return true;
      const tab = [...document.querySelectorAll('[data-slot="tabs-trigger"][title]')].at(-1);
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
        tab?.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
      return false;
    })()`
    await until(
      () => hasgard(socket, showOtherTab).catch(() => false),
      shown => shown === true,
      60,
      "GitCub repository rail",
      200
    )
    await until(
      () =>
        hasgard(socket, `${gitcubChangesExpression} === ${expected === 1 ? 2 : 1} && !!${target}`).catch(() => false),
      shown => shown === true,
      60,
      "GitCub small repository"
    )
    await hasgard(
      socket,
      armExpression(`${target}?.getAttribute('aria-current') === 'page' ? ${gitcubChangesExpression} : -1`, expected)
    )
    await hasgard(socket, clickExpression(`${target}.click()`))
    const [repositoryMs, changes] = await until(
      () => hasgard(socket, finishedExpression).catch(() => null) as Promise<[number, number] | null>,
      done => done !== null,
      120,
      "GitCub changes list"
    ).then(done => done!)
    await sleep(settle)
    const afterRepository = await processTree(child.pid!, helpersBefore)
    if (heapSnapshot) await writeHeapSnapshot(socket, join(heapSnapshot, "repository.heap.json"))
    // BENCH_REPOSITORY_HOOK=<shell command>: run once the repository is open and settled, with the process ids in
    // BENCH_PIDS ("<pid>:<command>" per line), e.g. to point vmmap or heap at the WebContent process. Launch with
    // __XPC_Malloc=1 (and __XPC_MallocStackLogging=lite) to have WebKit's helpers allocate through the system
    // allocator so those tools can attribute their memory; numbers from such a run are for analysis only.
    if (process.env.BENCH_REPOSITORY_HOOK) {
      const hook = Bun.spawn(["sh", "-c", process.env.BENCH_REPOSITORY_HOOK], {
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, BENCH_PIDS: afterRepository.map(entry => `${entry.pid}:${entry.command}`).join("\n") }
      })
      await hook.exited
    }
    const idleFrom = traceSize(directory)
    await sleep(settle)
    const git = gitProcesses(directory, idleFrom)
    const diff = diffLines > 0 ? await measureDiff(expression => hasgard(socket, expression), diffLines) : null
    if (diff) await sleep(settle)
    sample = {
      readyMs,
      windowMs,
      repositoryMs,
      changes,
      ready,
      afterRepository,
      git,
      diff,
      afterDiff: diff ? await processTree(child.pid!, helpersBefore) : null
    }
  } finally {
    stop.done = true
    await terminate(child)
    rmSync(directory, { recursive: true, force: true })
  }
  await sleep(1000)
  const readyTree = await ownProcesses(sample.ready)
  const repositoryTree = await ownProcesses(sample.afterRepository)
  const diffTree = sample.afterDiff ? await ownProcesses(sample.afterDiff) : null
  return {
    readyMs: sample.readyMs,
    windowMs: sample.windowMs,
    rssReadyKiB: sum(readyTree),
    repositoryMs: sample.repositoryMs,
    changes: sample.changes,
    rssRepositoryKiB: sum(repositoryTree),
    diff: sample.diff,
    rssDiffKiB: diffTree ? sum(diffTree) : null,
    footprintKiB: {
      ready: footprintSum(readyTree),
      repository: footprintSum(repositoryTree),
      diff: diffTree ? footprintSum(diffTree) : null
    },
    gitProcesses: sample.git,
    processes: { ready: readyTree, repository: repositoryTree }
  }
}

const traceSize = (directory: string) => {
  try {
    return statSync(join(directory, "trace2.json")).size
  } catch {
    return 0
  }
}

/** Top-level `start` events (a sid without `/`; git's own children nest under their parent) up to `idleFrom` and after it. */
function gitProcesses(directory: string, idleFrom: number): NonNullable<Sample["gitProcesses"]> {
  let text = ""
  try {
    text = readFileSync(join(directory, "trace2.json"), "utf8")
  } catch {
    // No trace file means git never started: zero processes.
  }
  const starts = (from: number, to: number) =>
    text
      .slice(from, to)
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; sid: string; argv: string[] })
      .filter(event => event.event === "start" && !event.sid.includes("/"))
  const repository = starts(0, idleFrom)
  const idle = starts(idleFrom, text.length)
  const commands: Record<string, number> = {}
  for (const event of [...repository, ...idle]) {
    // argv[0] is git itself; skip `-C <dir>`, `-c <k=v>` and other leading options to the subcommand
    const args = event.argv.slice(1)
    let i = 0
    while (i < args.length && args[i]!.startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1
    const name = args[i] ?? "?"
    commands[name] = (commands[name] ?? 0) + 1
  }
  // Full argv of each one, so a fast path that deferred to git can be traced to its call.
  return { repository: repository.length, idle: idle.length, commands, argv: [...repository, ...idle].map(e => e.argv) }
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

async function launchDesktop(repository: string, settle: number, expected: number, diffLines: number): Promise<Sample> {
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
      () => devtools.evaluate(submitEnabledExpression).catch(() => false),
      enabled => enabled === true,
      60,
      "Desktop add repository button",
      50
    )
    await devtools.evaluate(armExpression(desktopChangesExpression, expected))
    await devtools.evaluate(
      clickExpression(`document.querySelector('#add-existing-repository button[type="submit"]').click()`)
    )
    const [repositoryMs, changes] = await until(
      () => devtools.evaluate(finishedExpression).catch(() => null) as Promise<[number, number] | null>,
      done => done !== null,
      120,
      "Desktop changes list"
    ).then(done => done!)
    await sleep(settle)
    const afterRepository = await processTree(child.pid!, helpersBefore)
    const diff = diffLines > 0 ? await measureDiff(expression => devtools.evaluate(expression), diffLines) : null
    if (diff) await sleep(settle)
    const afterDiff = diff ? await processTree(child.pid!, helpersBefore) : null
    return {
      readyMs,
      windowMs,
      rssReadyKiB: sum(ready),
      repositoryMs,
      changes,
      rssRepositoryKiB: sum(afterRepository),
      diff,
      rssDiffKiB: afterDiff ? sum(afterDiff) : null,
      footprintKiB: {
        ready: footprintSum(ready),
        repository: footprintSum(afterRepository),
        diff: afterDiff ? footprintSum(afterDiff) : null
      },
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
    diffOpenMs: samples.every(sample => sample.diff) ? median(samples.map(sample => sample.diff!.openMs)) : null,
    diffScrollMs: samples.every(sample => sample.diff) ? median(samples.map(sample => sample.diff!.scrollMs)) : null,
    rssDiffKiB: samples.every(sample => sample.rssDiffKiB !== null)
      ? median(samples.map(sample => sample.rssDiffKiB!))
      : null,
    footprintKiB: {
      ready: median(samples.map(sample => sample.footprintKiB.ready)),
      repository: median(samples.map(sample => sample.footprintKiB.repository)),
      diff: samples.every(sample => sample.footprintKiB.diff !== null)
        ? median(samples.map(sample => sample.footprintKiB.diff!))
        : null
    },
    changes: samples[0]?.changes ?? 0,
    gitProcesses: samples[0]?.gitProcesses
      ? {
          repository: median(samples.map(sample => sample.gitProcesses?.repository ?? 0)),
          idle: median(samples.map(sample => sample.gitProcesses?.idle ?? 0))
        }
      : null
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
    if (options.dirty > 0) {
      const modified = Math.min(Math.ceil(options.dirty / 2), options.files)
      for (let i = 0; i < modified; i++) {
        const path = join(repository, `src/module-${String(Math.floor(i / 100)).padStart(4, "0")}/file-${i % 100}.ts`)
        appendFileSync(path, "// dirty\n")
      }
      mkdirSync(join(repository, "untracked"))
      for (let i = modified; i < options.dirty; i++) writeFileSync(join(repository, `untracked/new-${i}.ts`), `${i}\n`)
      console.log(`Dirtied: ${modified} modified, ${options.dirty - modified} untracked`)
    }
    if (options.diffLines > 0) {
      // Tracked and modified, so status (and both lists) put it first: untracked files come after every tracked change.
      writeFileSync(join(repository, diffProbe), "probe\n")
      writeFileSync(join(repository, firstChange), "first\n")
      // `--only` commits just the probe; the synthetic repository's other staged changes stay staged.
      for (const args of [
        ["add", "--", diffProbe, firstChange],
        [
          ...["-c", "user.name=Bench", "-c", "user.email=bench@example.invalid", "-c", "commit.gpgsign=false"],
          ...["commit", "-q", "-m", "Diff probe", "--only", "--", diffProbe, firstChange]
        ]
      ]) {
        const result = Bun.spawnSync(["git", "-C", repository, ...args])
        if (result.exitCode !== 0) throw new Error(`diff probe: git ${args.join(" ")}: ${result.stderr.toString()}`)
      }
      const lines = Array.from({ length: options.diffLines }, (_, n) => `${diffLine(n)}\n`)
      writeFileSync(join(repository, diffProbe), lines.join(""))
      writeFileSync(join(repository, firstChange), "first changed\n")
    }
  } else if (options.dirty > 0) throw new Error("--dirty only applies to the synthetic repository")
  const diffLines = options.repo ? 0 : options.diffLines
  // The list counts as rendered only once it shows every change: a 0 drawn before status lands would stop the clock early
  const status = Bun.spawnSync([
    "git",
    "--no-optional-locks",
    "-C",
    repository,
    "status",
    "--porcelain=v1",
    "-z",
    "-uall"
  ])
  if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr.toString()}`)
  const expected = status.stdout
    .toString()
    .split("\0")
    .filter(entry => /^.. /.test(entry)).length
  console.log(`Expected changes: ${expected}`)
  for (let launch = 1; launch <= options.launches; launch++) {
    console.log(`Launch ${launch}/${options.launches}: GitCub…`)
    const heapSnapshot = launch === 1 ? options.heapSnapshot : null
    gitcub.push(await launchGitCub(bundle, repository, options.settle, expected, diffLines, heapSnapshot))
    await sleep(1000)
    if (compareDesktop) {
      console.log(`Launch ${launch}/${options.launches}: GitHub Desktop…`)
      desktop.push(await launchDesktop(repository, options.settle, expected, diffLines))
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
  const ms = (value: number | null) => (value === null ? "—" : value.toFixed(0))
  const diffRow = (name: string, s: ReturnType<typeof summarize>) =>
    `| ${name} | ${ms(s.diffOpenMs)} | ${ms(s.diffScrollMs)} | ${s.rssDiffKiB === null ? "—" : mib(s.rssDiffKiB)} |`
  if (summary.gitcub.diffOpenMs !== null) {
    console.log(`\n| 应用 | 打开 ${diffLines} 行 diff (ms) | 滚到末行 (ms) | diff 后 RSS (MiB) |`)
    console.log("|---|---:|---:|---:|")
    console.log(diffRow("GitCub", summary.gitcub))
    if (summary.desktop) console.log(diffRow("GitHub Desktop", summary.desktop))
  }
  const footprintRow = (name: string, s: ReturnType<typeof summarize>) =>
    `| ${name} | ${mib(s.footprintKiB.ready)} | ${mib(s.footprintKiB.repository)} | ${s.footprintKiB.diff === null ? "—" : mib(s.footprintKiB.diff)} |`
  console.log("\n| 应用 | 就绪后 footprint (MiB) | 打开仓库后 footprint (MiB) | diff 后 footprint (MiB) |")
  console.log("|---|---:|---:|---:|")
  console.log(footprintRow("GitCub", summary.gitcub))
  if (summary.desktop) console.log(footprintRow("GitHub Desktop", summary.desktop))
  if (summary.gitcub.gitProcesses)
    console.log(
      `\nGitCub git processes (median): launch + open ${summary.gitcub.gitProcesses.repository}, idle ${summary.gitcub.gitProcesses.idle}; first launch by subcommand: ${JSON.stringify(gitcub[0]?.gitProcesses?.commands ?? {})}`
    )

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
