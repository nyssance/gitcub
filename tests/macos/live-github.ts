// Explicitly opt-in live acceptance. Operates only on a disposable branch/PR in
// --repository owner/name, never commits to or merges the repository default branch.
import assert from "node:assert/strict"
import { type ChildProcess, execFile, spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
const exec = promisify(execFile)
const repository = process.argv[process.argv.indexOf("--repository") + 1]
if (!process.argv.includes("--repository") || !/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error("Specify --repository owner/name after authorizing live writes")
if (process.platform !== "darwin") throw new Error("macOS is required")
const [owner, name] = repository.split("/")
const root = resolve(import.meta.dirname, "../..")
const directory = await mkdtemp("/private/tmp/gitcub-live-")
const socket = join(directory, "hasgard.sock")
const branch = `gitcub-acceptance-${Date.now()}`
const clone = join(directory, "repository")
const report: Record<string, unknown> = {
  repository,
  branch,
  directory,
  at: new Date().toISOString(),
  completed: [],
  cleanup: {}
}
const completed = report.completed as string[]
const metadata = JSON.parse((await exec("gh", ["api", `repos/${repository}`])).stdout)
assert.equal(metadata.permissions.push, true)
const account = JSON.parse((await exec("gh", ["api", "user"])).stdout)
const bundle = join(directory, "GitCub Live Acceptance.app")
await cp(join(root, "src-tauri/target/debug/bundle/macos/GitCub.app"), bundle, { recursive: true })
const credentialDirectory = join(directory, "day.dreamer.gitcub/dev-tokens")
await mkdir(credentialDirectory, { recursive: true })
const credential = join(credentialDirectory, "github_com")
// Capture the existing CLI credential in memory; never include it in arguments,
// console output, reports or Hasgard commands. Remove the isolated copy in finally.
const config = join(directory, "gitconfig")
let app: ChildProcess | undefined
let pushed = false
let pullNumber: number | undefined
let requestId = 0
async function evaluate(expression: string) {
  const { stdout } = await exec("tauri-hasgard", ["--socket", socket, "--json", "eval", expression], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const result = JSON.parse(stdout)
  if (result?.error) throw new Error(JSON.stringify(result.error))
  return result
}
/** Stands in for a Tauri Channel argument in `invoke` */
const CHANNEL = "__gitcubAcceptanceChannel__"
async function invoke(command: string, args: unknown = {}) {
  const id = String(++requestId)
  // Hasgard limits each eval to 10s. Keep long native operations outside that
  // eval promise and poll their result; do not repeatedly invoke the operation.
  await evaluate(`(() => {
    const calls = window.__gitcubAcceptanceCalls ??= {};
    calls[${JSON.stringify(id)}] = { pending: true };
    // Commands that stream output or hook events take channels; a fresh, unread channel per placeholder
    const args = JSON.parse(${JSON.stringify(JSON.stringify(args))}, (_, value) =>
      value === ${JSON.stringify(CHANNEL)} ? "__CHANNEL__:" + window.__TAURI_INTERNALS__.transformCallback(() => {}) : value);
    window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, args).then(
      value => calls[${JSON.stringify(id)}] = { value },
      error => calls[${JSON.stringify(id)}] = { failure: String(error) }
    );
    return true;
  })()`)
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const result = await evaluate(`(() => {
      const calls = window.__gitcubAcceptanceCalls;
      const result = calls[${JSON.stringify(id)}];
      if (!result.pending) delete calls[${JSON.stringify(id)}];
      return result;
    })()`)
    if (result.failure) throw new Error(`${command}: ${result.failure}`)
    if (!result.pending) return result.value
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`${command}: native operation timed out after 180s`)
}
async function until(check: () => Promise<boolean>, seconds: number, step: string) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  throw new Error(`${step}: deadline exceeded after ${seconds} seconds`)
}
const record = (step: string) => {
  completed.push(step)
  console.log(`Verified: ${step}`)
}
try {
  await writeFile(credential, (await exec("gh", ["auth", "token", "--hostname", "github.com"])).stdout.trim(), {
    mode: 0o600
  })
  await writeFile(
    config,
    `[user]\nname = GitCub acceptance\nemail = ${account.id}+${account.login}@users.noreply.github.com\n[commit]\ngpgsign = false\n[core]\nhooksPath = /dev/null\n`
  )
  app = spawn(join(bundle, "Contents/MacOS/gitcub"), [], {
    env: {
      ...process.env,
      TAURI_HASGARD_SOCKET: socket,
      GITCUB_TEST_DATA_DIR: directory,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1"
    },
    stdio: "ignore"
  })
  let launchError: Error | undefined
  app.on("error", error => {
    launchError = error
  })
  await until(
    async () => {
      if (launchError) throw launchError
      try {
        await invoke("load_state")
        return true
      } catch {
        return false
      }
    },
    45,
    "native application startup"
  )
  const accounts = await invoke("account_info", { hosts: ["github.com"], refresh: true })
  assert.equal(accounts["github.com"].login, account.login)
  record("native account lookup against GitHub")
  await invoke("clone_repo", { url: `https://github.com/${repository}.git`, path: clone })
  record("native HTTPS private repository clone")
  await invoke("create_branch", { repo: clone, name: branch, startPoint: null, noTrack: true })
  await invoke("checkout", { repo: clone, branch })
  const path = ".github/workflows/gitcub-live-acceptance.yml"
  await mkdir(join(clone, ".github/workflows"), { recursive: true })
  await writeFile(
    join(clone, path),
    `name: GitCub live acceptance\non: pull_request\npermissions:\n  contents: read\njobs:\n  retry:\n    name: GitCub live retry\n    runs-on: ubuntu-latest\n    steps:\n      - name: Fail first attempt, pass native retry\n        run: test "$GITHUB_RUN_ATTEMPT" -gt 1\n`
  )
  await invoke("apply_selection", { repo: clone, files: [{ path, oldPath: null, include: "all", patch: null }] })
  await invoke("commit", {
    repo: clone,
    summary: "test: temporary GitCub live workflow acceptance",
    description: "Disposable acceptance commit; never merge.",
    options: {},
    hooks: null,
    events: CHANNEL,
    output: CHANNEL
  })
  const sha = (await exec("git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim()
  report.sha = sha
  await invoke("push_with_tags", {
    repo: clone,
    remote: "origin",
    branch,
    tags: [],
    options: { setUpstream: true },
    hooks: null,
    events: CHANNEL,
    progress: CHANNEL
  })
  pushed = true
  record("native stage, commit and authenticated push")
  await invoke("fetch", { repo: clone, remote: "origin" })
  await invoke("pull", { repo: clone, remote: "origin" })
  assert.equal((await exec("git", ["-C", clone, "rev-parse", "@{upstream}"])).stdout.trim(), sha)
  record("native fetch/pull and upstream tracking")
  const pull = await invoke("create_pull_request", {
    host: "github.com",
    owner,
    name,
    head: branch,
    base: metadata.default_branch,
    title: "[Temporary acceptance] GitCub native GitHub workflow — do not merge",
    body: "Authorized GitCub acceptance run. Exercises native clone, stage, commit, push, PR creation, CI discovery and failed-job retry. The dedicated job intentionally fails on its first attempt. This PR will be closed and its temporary branch deleted after verification; no merge is intended."
  })
  pullNumber = Number(new URL(pull).pathname.split("/").at(-1))
  assert.ok(Number.isSafeInteger(pullNumber) && pullNumber > 0)
  report.pullRequest = pull
  record("native pull request creation")
  let retry: { kind: string; id: number } | undefined
  await until(
    async () => {
      const checks = await invoke("check_runs", { host: "github.com", owner, name, sha })
      const check = checks.find(
        (check: { name: string; conclusion: string | null }) =>
          check.name === "GitCub live retry" && check.conclusion === "failure"
      )
      retry = check?.retry
      return !!retry
    },
    480,
    "GitHub initial CI failure"
  )
  report.retry = retry
  await invoke("rerun_failed_jobs", { host: "github.com", owner, name, target: retry })
  record("native failed CI workflow retry")
  await until(
    async () => {
      const run = JSON.parse((await exec("gh", ["api", `repos/${repository}/actions/runs/${retry!.id}`])).stdout)
      return run.run_attempt >= 2 && run.conclusion === "success"
    },
    480,
    "GitHub retry success"
  )
  record("GitHub independently confirms retry success")
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  const cleanup = report.cleanup as Record<string, unknown>
  if (pullNumber) {
    try {
      await exec("gh", ["api", "-X", "PATCH", `repos/${repository}/pulls/${pullNumber}`, "-f", "state=closed"])
      cleanup.pullClosed = true
    } catch (error) {
      cleanup.pullError = String(error)
      process.exitCode = 1
    }
  }
  if (pushed) {
    try {
      await invoke("delete_remote_branch", { repo: clone, remote: "origin", name: branch })
      cleanup.branchDeleted = true
    } catch (error) {
      cleanup.branchError = String(error)
      process.exitCode = 1
    }
  }
  if (app) {
    await invoke("request_quit", { force: true }).catch(() => {})
    if (app.exitCode === null) app.kill("SIGTERM")
  }
  try {
    await unlink(credential)
    cleanup.credentialRemoved = true
  } catch (error) {
    cleanup.credentialRemoved = (error as NodeJS.ErrnoException).code === "ENOENT"
    if (!cleanup.credentialRemoved) {
      cleanup.credentialError = String(error)
      process.exitCode = 1
    }
  }
  const output = join(root, "test-results/live-github")
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
}
