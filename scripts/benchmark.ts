// Hot-path benchmark driver: builds the Rust `benchmark` example, prepares a
// synthetic large working tree, runs every repository through it and writes a
// JSON report. The git CLI timings are a lower bound for Desktop: they include
// process start-up and output, not dugite's JavaScript parsing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import { machine } from "./bench-machine.ts"
import { createSyntheticRepository } from "./synthetic-repository.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const binary = join(root, "src-tauri/target/release/examples/benchmark")

interface Options {
  repositories: string[]
  iterations: number
  limit: number
  skip: number
  synthetic: boolean
  files: number
  commits: number
  build: boolean
  systemGit: boolean
}

interface Measurement {
  samples_ms: number[]
  min_ms: number
  median_ms: number
  max_ms: number
  result: number
}

interface RepositoryReport {
  repo: string
  head: string
  iterations: number
  limit: number
  skip: number
  commits: number
  tracked_files: number
  workloads: Array<{ name: string; command: string; gitcub: Measurement; desktop: Measurement }>
  /** In-process blame checked byte for byte against git (HEAD and worktree) before timing; refusals fall back to git. */
  blame_engine: { files: string[]; identical: number; refused: string[] }
  /** Old files blamed one by one with the in-process phases (medians, ms) next to Desktop's `blame --porcelain -- <file>`. */
  blame_breakdown: Array<{
    file: string
    gitcub_median_ms: number
    desktop_median_ms: number
    setup_ms: number
    lookup_ms: number
    diff_ms: number
    diff_inline_ms: number
    rename_ms: number
    output_ms: number
    other_ms: number
    passes: number
    lookups: number
  }>
  /** Each phase of `status::status` timed on its own, starting from a freshly opened repository. */
  status_breakdown: Array<{ phase: string; timing: Measurement }>
  /** Reading references: open, iteration with and without prefixes, loose file reads, the ref index. */
  refs_breakdown: Array<{ phase: string; timing: Measurement }>
}

function parseArguments(argv: string[]): Options {
  const options: Options = {
    repositories: [],
    iterations: 10,
    limit: 100,
    skip: 2000,
    synthetic: true,
    files: 50_000,
    commits: 200,
    build: true,
    systemGit: false
  }
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${argument} needs a value`)
      const parsed = Number(next)
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${argument} needs a non-negative integer`)
      return parsed
    }
    switch (argument) {
      case "--iterations":
        options.iterations = value()
        break
      case "--limit":
        options.limit = value()
        break
      case "--skip":
        options.skip = value()
        break
      case "--files":
        options.files = value()
        break
      case "--commits":
        options.commits = value()
        break
      case "--no-synthetic":
        options.synthetic = false
        break
      case "--no-build":
        options.build = false
        break
      // GitCub side uses git from PATH instead of the bundled git and its system config (the app's default)
      case "--system-git":
        options.systemGit = true
        break
      default:
        if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`)
        options.repositories.push(argument)
    }
  }
  return options
}

function run(command: string[], cwd = root, env: Record<string, string | undefined> = process.env) {
  const result = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** Repository stopped in a merge: text conflicts with markers, binary conflicts and a `merge=binary` path. */
function createConflictRepository(directory: string, files: number, conflicts: number) {
  const git = (...args: string[]) => run(["git", "-C", directory, ...args])
  mkdirSync(directory)
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Benchmark")
  git("config", "user.email", "benchmark@example.invalid")
  git("config", "commit.gpgsign", "false")
  const path = (i: number) => `src/module-${String(Math.floor(i / 100)).padStart(3, "0")}/file-${i % 100}.txt`
  const body = (i: number, line: (n: number) => string) =>
    `${Array.from({ length: 40 }, (_, n) => (n === 20 ? line(n) : `line ${n} of file ${i}`)).join("\n")}\n`
  const write = (relative: string, content: string | Uint8Array) => {
    mkdirSync(join(directory, relative, ".."), { recursive: true })
    writeFileSync(join(directory, relative), content)
  }
  write(".gitattributes", "*.lock merge=binary\n")
  for (let i = 0; i < files; i++)
    write(
      path(i),
      body(i, n => `line ${n} of file ${i}`)
    )
  const binary = (tag: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, ...new TextEncoder().encode(tag)])
  for (let i = 0; i < 2; i++) write(`assets/image-${i}.png`, binary("base"))
  write("deps.lock", "base\n")
  git("add", "-A")
  git("commit", "-qm", "Base")
  // A little history so the HEAD~5 based rows have something to walk.
  for (let k = 0; k < 8; k++) {
    write(
      path(files - 300 - k),
      body(files - 300 - k, n => `history ${k} ${n}`)
    )
    git("commit", "-qam", `History ${k}`)
  }
  const side = (tag: string) => {
    for (let i = 0; i < conflicts; i++)
      write(
        path(i * 7),
        body(i * 7, n => `${tag} change ${n}`)
      )
    for (let i = 0; i < 2; i++) write(`assets/image-${i}.png`, binary(tag))
    write("deps.lock", `${tag}\n`)
  }
  git("checkout", "-q", "-b", "side")
  side("theirs")
  for (let i = 0; i < 200; i++)
    write(
      path(files - 1 - i),
      body(files - 1 - i, n => `theirs only ${n}`)
    )
  git("commit", "-qam", "Theirs")
  git("checkout", "-q", "main")
  side("ours")
  git("commit", "-qam", "Ours")
  const merged = Bun.spawnSync(["git", "-C", directory, "merge", "-q", "side"], { stdout: "pipe", stderr: "pipe" })
  if (merged.exitCode !== 1) throw new Error(`expected a conflicted merge:\n${merged.stderr.toString()}`)
}

const options = parseArguments(process.argv.slice(2))
if (options.build) {
  console.log("Building the release benchmark example…")
  run(["cargo", "build", "--locked", "--release", "--manifest-path", "src-tauri/Cargo.toml", "--example", "benchmark"])
}

const temporary = mkdtempSync(join(tmpdir(), "gitcub-benchmark-"))
// Spotlight skips `*.noindex` directories: 50 000 fresh files would otherwise keep mds busy for the whole run.
const scratch = join(temporary, "repos.noindex")
mkdirSync(scratch)
const repositories = [...options.repositories]
try {
  if (options.synthetic) {
    const synthetic = join(scratch, `synthetic-${options.files}-files`)
    console.log(`Preparing ${synthetic} (${options.files} files, ${options.commits} commits)…`)
    createSyntheticRepository(synthetic, options.files, options.commits)
    const conflicted = join(scratch, "merge-conflict-5000-files")
    console.log(`Preparing ${conflicted} (5000 files, 30 text and 3 binary conflicts)…`)
    createConflictRepository(conflicted, 5000, 30)
    repositories.unshift(synthetic, conflicted)
  }
  if (repositories.length === 0) throw new Error("Pass at least one repository or keep the synthetic one")

  // A partial clone sends the git side to the network for every missing blob, which times the
  // network instead of git and leaves one promisor pack per fetch behind; benchmark a full clone.
  for (const repository of repositories) {
    const promisor = Bun.spawnSync([
      "git",
      "-C",
      repository,
      "config",
      "--get-regexp",
      String.raw`^remote\..*\.promisor$`
    ])
    if (promisor.stdout.toString().includes("true"))
      throw new Error(`${repository} is a partial clone; pass a full clone instead (git clone --single-branch <url>)`)
  }
  const reports: RepositoryReport[] = []
  for (const repository of repositories) {
    console.log(`Benchmarking ${repository}…`)
    const output = run(
      [
        binary,
        "--repo",
        repository,
        "--iterations",
        String(options.iterations),
        "--limit",
        String(options.limit),
        "--skip",
        String(options.skip),
        ...(options.systemGit ? ["--system-git"] : [])
      ],
      root,
      { ...process.env, GIT_NO_LAZY_FETCH: "1" }
    )
    reports.push(JSON.parse(output) as RepositoryReport)
  }

  const lines: string[] = []
  for (const report of reports) {
    lines.push(
      "",
      `### ${basename(report.repo)} — ${report.commits} commits, ${report.tracked_files} tracked files`,
      "",
      "| Workload | GitCub median (ms) | git CLI median (ms) | GitCub min (ms) | git CLI min (ms) | Speed-up |",
      "|---|---:|---:|---:|---:|---:|"
    )
    for (const workload of report.workloads) {
      const ratio = workload.desktop.median_ms / workload.gitcub.median_ms
      lines.push(
        `| ${workload.name} (${workload.command}) | ${workload.gitcub.median_ms.toFixed(1)} | ${workload.desktop.median_ms.toFixed(1)} | ${workload.gitcub.min_ms.toFixed(1)} | ${workload.desktop.min_ms.toFixed(1)} | ${ratio.toFixed(2)}× |`
      )
    }
    const engine = report.blame_engine
    lines.push(
      "",
      `blame engine: ${engine.identical} of ${engine.files.length * 2} outputs identical to git, ${engine.refused.length} fell back${engine.refused.length ? ` (${engine.refused.join("; ")})` : ""}`
    )
    lines.push(
      "",
      "| old-file blame | GitCub (ms) | git CLI (ms) | Speed-up | setup | lookup | diff | rename | output | other | origins | lookups |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
    )
    for (const row of report.blame_breakdown)
      lines.push(
        `| ${row.file} | ${row.gitcub_median_ms.toFixed(1)} | ${row.desktop_median_ms.toFixed(1)} | ${(row.desktop_median_ms / row.gitcub_median_ms).toFixed(2)}× | ${row.setup_ms.toFixed(1)} | ${row.lookup_ms.toFixed(1)} | ${(row.diff_ms + row.diff_inline_ms).toFixed(1)} | ${row.rename_ms.toFixed(1)} | ${row.output_ms.toFixed(1)} | ${row.other_ms.toFixed(1)} | ${row.passes} | ${row.lookups} |`
      )
    lines.push("", "| status phase | median (ms) | min (ms) |", "|---|---:|---:|")
    for (const { phase, timing } of report.status_breakdown)
      lines.push(`| ${phase} | ${timing.median_ms.toFixed(1)} | ${timing.min_ms.toFixed(1)} |`)
    lines.push("", "| refs phase | median (ms) | min (ms) |", "|---|---:|---:|")
    for (const { phase, timing } of report.refs_breakdown)
      lines.push(`| ${phase} | ${timing.median_ms.toFixed(2)} | ${timing.min_ms.toFixed(2)} |`)
  }
  console.log(lines.join("\n"))

  const directory = join(root, "test-results/benchmark")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, "report.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scope:
          "git CLI timings cover the git process only (start-up, execution, output); Desktop additionally parses in JavaScript, so they are a lower bound for Desktop.",
        machine: machine(),
        options,
        repositories: reports.map(report => ({ ...report, label: basename(report.repo) }))
      },
      null,
      2
    )}\n`
  )
  console.log(`\nReport written to ${join(directory, "report.json")}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
