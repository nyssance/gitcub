// Read-only live acceptance of Git transport against a self-hosted GitLab:
// HTTPS fetch of a subgroup project, SSH refused for an account without access,
// and recovery after the network comes back. Runs the production net::fetch
// through the conformance bridge; nothing is written to the remote.
//
//   GITCUB_LIVE_GITLAB_HOST=<host> bun tests/macos/live-gitlab-transport.ts --project group/sub/name
//
// The host is redacted from every line printed.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const host = argument("--host") ?? process.env.GITCUB_LIVE_GITLAB_HOST
if (!host) throw new Error("Set GITCUB_LIVE_GITLAB_HOST (hostname only) or pass --host")
const project = argument("--project")
if (!project) throw new Error("Specify --project group/subgroup/name")
const redact = (text: string) => text.replaceAll(host, "<host>")

// The conformance bridge binary (cargo build --example conformance), called the way tests/conformance/bridge.ts does.
const bridge = resolve(import.meta.dirname, "../../src-tauri/target/debug/examples/conformance")
const call = (operation: string, args: Record<string, unknown>) => {
  const result = spawnSync(bridge, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    input: JSON.stringify({ operation, ...args }),
    encoding: "utf8",
    timeout: 60000
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `Rust bridge exited ${result.status}`)
  const output = JSON.parse(result.stdout)
  if (output?.error) throw new Error(output.error)
  return output
}

const root = mkdtempSync(join(tmpdir(), "gitcub-live-transport-"))
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
let failed = false
const check = (name: string, ok: boolean, detail = "") => {
  failed ||= !ok
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${redact(detail)}` : ""}`)
}
const fetch = (repo: string, remote: string) => {
  const started = performance.now()
  try {
    call("remote/fetch", { repo, remote })
    return { error: undefined, seconds: (performance.now() - started) / 1000 }
  } catch (error) {
    return { error: String(error), seconds: (performance.now() - started) / 1000 }
  }
}

try {
  const repo = join(root, "repo")
  execFileSync("git", ["init", "-q", repo])
  git(repo, "remote", "add", "origin", `https://${host}/${project}.git`)
  const https = fetch(repo, "origin")
  const heads = https.error ? "" : git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin")
  check("HTTPS 拉取子组项目", !https.error && heads.length > 0, https.error ?? `${heads.split("\n").length} 个远端分支`)

  // An SSH key the instance knows but which has no access to the project: GitLab answers with its own message,
  // and the fetch must fail promptly instead of waiting for a prompt.
  git(repo, "remote", "add", "ssh", `git@${host}:${project}.git`)
  const ssh = fetch(repo, "ssh")
  check(
    "SSH 无权限时报出 GitLab 的原因且不挂起",
    ssh.error?.includes("you don't have permission") === true && ssh.seconds < 30,
    `${ssh.seconds.toFixed(1)}s ${ssh.error?.split("\n").find(line => line.includes("permission")) ?? ssh.error ?? "未报错"}`
  )

  git(repo, "remote", "add", "offline", `https://127.0.0.1:1/${project}.git`)
  const offline = fetch(repo, "offline")
  check("断网时拉取失败而不挂起", offline.error !== undefined && offline.seconds < 30, offline.error?.split("\n")[0])
  const recovered = fetch(repo, "origin")
  check("网络恢复后同一仓库再次拉取成功", !recovered.error, recovered.error)
} finally {
  rmSync(root, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
