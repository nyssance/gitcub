// Explicitly opt-in live acceptance against a self-hosted GitLab instance you
// control. Operates only on a disposable branch/MR in --project group/sub/name,
// never commits to or merges the project default branch. The instance hostname
// is taken from GITCUB_LIVE_GITLAB_HOST or --host and is redacted from every
// report and console line; the token stays in memory and the isolated copy the
// application reads is removed in finally.
import assert from "node:assert/strict"
import { type ChildProcess, execFile, spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
const exec = promisify(execFile)
const argument = (flag: string) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined
const project = argument("--project")
if (!project || !/^[\w.-]+(\/[\w.-]+)+$/.test(project))
  throw new Error("Specify --project group/subgroup/name after authorizing live writes")
const host = argument("--host") ?? process.env.GITCUB_LIVE_GITLAB_HOST
if (!host || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host))
  throw new Error("Set GITCUB_LIVE_GITLAB_HOST (hostname only) or pass --host")
if (process.platform !== "darwin") throw new Error("macOS is required")
const owner = project.slice(0, project.lastIndexOf("/"))
const name = project.slice(project.lastIndexOf("/") + 1)
const encoded = encodeURIComponent(project)
const root = resolve(import.meta.dirname, "../..")
const directory = await mkdtemp("/private/tmp/gitcub-live-")
const socket = join(directory, "hasgard.sock")
const branch = `gitcub-acceptance-${Date.now()}`
const clone = join(directory, "repository")
const jobName = "gitcub-live-retry"
const redact = (text: string) => text.replaceAll(host, "<host>")
const report: Record<string, unknown> = {
  project,
  branch,
  directory,
  at: new Date().toISOString(),
  completed: [],
  skipped: {},
  cleanup: {}
}
const completed = report.completed as string[]
const skipped = report.skipped as Record<string, string>
// `git credential fill` asks the configured helper (the macOS keychain here) in
// memory only; the token never enters arguments, console output, reports or
// Hasgard commands.
const credentialLines = await new Promise<string>((resolveLines, reject) => {
  const child = spawn("git", ["credential", "fill"], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.on("error", reject)
  child.on("close", code =>
    code === 0 ? resolveLines(output) : reject(new Error(`git credential fill exited ${code}`))
  )
  child.stdin.end(`protocol=https\nhost=${host}\n\n`)
})
const token = credentialLines
  .split("\n")
  .find(line => line.startsWith("password="))
  ?.slice("password=".length)
if (!token) throw new Error("No stored credential for the GitLab host; sign in with git credential first")
async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://${host}/api/v4/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  if (!response.ok)
    throw new Error(`GitLab ${method} ${redact(path)}: HTTP ${response.status} ${redact(text).slice(0, 300)}`)
  return text ? (JSON.parse(text) as T) : (undefined as T)
}
// Follows GitLab's X-Next-Page header the same way host_api::list follows
// server pagination, so the expected set is independent of the native command.
async function paginate<T>(path: string): Promise<{ items: T[]; pages: number; total: number }> {
  const items: T[] = []
  let page = 1
  let pages = 0
  let total = 0
  while (page) {
    const response = await fetch(`https://${host}/api/v4/${path}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    })
    if (!response.ok) throw new Error(`GitLab GET ${redact(path)}: HTTP ${response.status}`)
    items.push(...((await response.json()) as T[]))
    pages += 1
    total = Number(response.headers.get("x-total") ?? items.length)
    page = Number(response.headers.get("x-next-page") || 0)
  }
  return { items, pages, total }
}
interface Project {
  id: number
  path_with_namespace: string
  default_branch: string
  visibility: string
  namespace: { full_path: string }
}
interface Job {
  id: number
  name: string
  status: string
  web_url: string
}
const metadata = await api<Project>("GET", `projects/${encoded}`)
assert.equal(metadata.path_with_namespace, project)
const account = await api<{ id: number; username: string }>("GET", "user")
const bundle = join(directory, "GitCub Live Acceptance.app")
await cp(join(root, "src-tauri/target/debug/bundle/macos/GitCub.app"), bundle, { recursive: true })
const credentialDirectory = join(directory, "day.dreamer.gitcub/dev-tokens")
await mkdir(credentialDirectory, { recursive: true })
// settings::dev_token_path keys the development store by host and replaces every
// character outside [A-Za-z0-9_-] with "_".
const credential = join(credentialDirectory, host.replaceAll(/[^A-Za-z0-9_-]/g, "_"))
const config = join(directory, "gitconfig")
let app: ChildProcess | undefined
let pushed = false
let mergeRequest: number | undefined
let requestId = 0
async function evaluate(expression: string) {
  const { stdout } = await exec("tauri-hasgard", ["--socket", socket, "--json", "eval", expression], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const result = JSON.parse(stdout)
  if (result?.error) throw new Error(redact(JSON.stringify(result.error)))
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
    if (result.failure) throw new Error(`${command}: ${redact(result.failure)}`)
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
const skip = (step: string, reason: string) => {
  skipped[step] = reason
  console.log(`Skipped: ${step} (${reason})`)
}
// No runner on this instance may accept untagged jobs; pick an online runner the
// project can use and tag the job for it, unless --ci-tags names the tags.
async function jobTags(): Promise<string[] | undefined> {
  const explicit = argument("--ci-tags")
  if (explicit) return explicit.split(",").filter(Boolean)
  const runners = await api<{ id: number; online: boolean | null; paused: boolean; active: boolean }[]>(
    "GET",
    `projects/${encoded}/runners?per_page=100`
  )
  for (const runner of runners) {
    if (!runner.online || runner.paused || !runner.active) continue
    const detail = await api<{ run_untagged: boolean; tag_list: string[]; platform: string | null }>(
      "GET",
      `runners/${runner.id}`
    ).catch(() => undefined)
    if (!detail || detail.platform === "windows") continue
    if (detail.run_untagged) return []
    if (detail.tag_list.length) return detail.tag_list
  }
  return undefined
}
try {
  await writeFile(credential, token, { mode: 0o600 })
  await writeFile(
    config,
    `[user]\nname = GitCub acceptance\nemail = ${account.id}-${account.username}@users.noreply.${host}\n[commit]\ngpgsign = false\n[core]\nhooksPath = /dev/null\n`
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
  const accounts = await invoke("account_info", { hosts: [host], refresh: true })
  assert.equal(accounts[host].kind, "gitlab")
  assert.equal(accounts[host].login, account.username)
  assert.ok(accounts[host].owners.includes(metadata.namespace.full_path.split("/")[0]))
  record("native account lookup against GitLab")
  const expected = await paginate<{ path_with_namespace: string }>("projects?membership=true&per_page=20")
  const listed = (await invoke("my_repos", { host, refresh: true })) as { owner: string; name: string }[]
  const paths = new Set(listed.map(repo => `${repo.owner}/${repo.name}`))
  assert.equal(paths.size, expected.total)
  for (const item of expected.items)
    assert.ok(paths.has(item.path_with_namespace), `missing ${item.path_with_namespace}`)
  assert.ok(paths.has(project))
  const subgroupProjects = expected.items.filter(item => item.path_with_namespace.split("/").length > 2)
  assert.ok(subgroupProjects.length > 0, "the account has no subgroup project to verify path handling")
  report.repositories = { total: expected.total, apiPages: expected.pages, subgroup: subgroupProjects.length }
  record("native repository listing with subgroup projects matches paginated API")
  await invoke("clone_repo", { url: `https://${host}/${project}.git`, path: clone })
  record("native HTTPS private project clone")
  await invoke("create_branch", { repo: clone, name: branch, startPoint: null, noTrack: true })
  await invoke("checkout", { repo: clone, branch })
  const tags = await jobTags()
  if (!tags) skip("GitLab CI retry", "no online runner is available to the project")
  const path = ".gitlab-ci.yml"
  // The job token may list the pipeline's jobs including retried ones, so the
  // first attempt (one job with this name) fails and the native retry passes.
  await writeFile(
    join(clone, path),
    `# Temporary GitCub live acceptance pipeline; the branch is deleted after the run.\n${jobName}:\n${tags?.length ? `  tags: [${tags.join(", ")}]\n` : ""}  script:\n    - 'attempts=$(curl -sSf --header "JOB-TOKEN: $CI_JOB_TOKEN" "$CI_API_V4_URL/projects/$CI_PROJECT_ID/pipelines/$CI_PIPELINE_ID/jobs?include_retried=true&per_page=100" | grep -o "\\"name\\":\\"$CI_JOB_NAME\\"" | wc -l)'\n    - 'echo "attempt $attempts of ${jobName}"; test "$attempts" -gt 1'\n`
  )
  await invoke("apply_selection", { repo: clone, files: [{ path, oldPath: null, include: "all", patch: null }] })
  await invoke("commit", {
    repo: clone,
    summary: "test: temporary GitCub live pipeline acceptance",
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
    events: CHANNEL
  })
  pushed = true
  record("native stage, commit and authenticated push")
  await invoke("fetch", { repo: clone, remote: "origin" })
  await invoke("pull", { repo: clone, remote: "origin" })
  assert.equal((await exec("git", ["-C", clone, "rev-parse", "@{upstream}"])).stdout.trim(), sha)
  record("native fetch/pull and upstream tracking")
  const url = await invoke("create_pull_request", {
    host,
    owner,
    name,
    head: branch,
    base: metadata.default_branch,
    title: "[Temporary acceptance] GitCub native GitLab workflow — do not merge",
    body: "Authorized GitCub acceptance run. Exercises native clone, stage, commit, push, merge request creation, pipeline discovery and failed-job retry. The dedicated job intentionally fails on its first attempt. This merge request will be closed and its temporary branch deleted after verification; no merge is intended."
  })
  mergeRequest = Number(new URL(url).pathname.split("/-/merge_requests/").at(-1))
  assert.ok(Number.isSafeInteger(mergeRequest) && mergeRequest > 0)
  report.mergeRequest = redact(url)
  record("native merge request creation")
  if (tags) {
    let retry: { kind: string; id: number } | undefined
    let stuck: string | undefined
    await until(
      async () => {
        const checks = await invoke("check_runs", { host, owner, name, sha })
        const check = checks.find(
          (check: { name: string; conclusion: string | null }) =>
            check.name === jobName && check.conclusion === "failure"
        )
        retry = check?.retry
        if (retry) return true
        const jobs = await api<Job[]>("GET", `projects/${encoded}/pipelines?sha=${sha}&per_page=10`).then(pipelines =>
          Promise.all(pipelines.map(pipeline => api<Job[]>("GET", `projects/${encoded}/pipelines/${pipeline.id}/jobs`)))
        )
        const job = jobs.flat().find(job => job.name === jobName)
        stuck = job && ["pending", "created"].includes(job.status) ? `job ${job.id} stayed ${job.status}` : undefined
        return false
      },
      300,
      "GitLab initial CI failure"
    ).catch(error => {
      if (!stuck) throw error
      skip("GitLab CI retry", `${stuck}: no runner picked up the tagged job within 300 seconds`)
    })
    if (retry) {
      assert.equal(retry.kind, "gitlabJob")
      report.retry = retry
      await invoke("rerun_failed_jobs", { host, owner, name, target: retry })
      record("native failed CI job retry")
      let retried: Job | undefined
      await until(
        async () => {
          const original = await api<Job & { pipeline: { id: number } }>("GET", `projects/${encoded}/jobs/${retry!.id}`)
          assert.equal(original.status, "failed")
          const jobs = await api<Job[]>(
            "GET",
            `projects/${encoded}/pipelines/${original.pipeline.id}/jobs?include_retried=true&per_page=100`
          )
          retried = jobs.find(job => job.name === jobName && job.id > retry!.id)
          return retried?.status === "success"
        },
        480,
        "GitLab retry success"
      )
      report.retriedJob = { id: retried!.id, status: retried!.status }
      record("GitLab independently confirms retry success")
    }
  }
} catch (error) {
  report.error = redact(String(error))
  process.exitCode = 1
} finally {
  const cleanup = report.cleanup as Record<string, unknown>
  if (mergeRequest) {
    try {
      const closed = await api<{ state: string }>("PUT", `projects/${encoded}/merge_requests/${mergeRequest}`, {
        state_event: "close"
      })
      cleanup.mergeRequestClosed = closed.state === "closed"
    } catch (error) {
      cleanup.mergeRequestError = redact(String(error))
      process.exitCode = 1
    }
  }
  if (pushed) {
    try {
      await invoke("delete_remote_branch", { repo: clone, remote: "origin", name: branch })
      cleanup.branchDeleted = true
    } catch (error) {
      cleanup.branchError = redact(String(error))
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
      cleanup.credentialError = redact(String(error))
      process.exitCode = 1
    }
  }
  const output = join(root, "test-results/live-gitlab")
  await mkdir(output, { recursive: true })
  const text = `${redact(JSON.stringify(report, null, 2))}\n`
  await writeFile(join(output, "report.json"), text)
  console.log(text)
}
