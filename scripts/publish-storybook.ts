/** Publish through alwith.dev's own CLI; it verifies source HEAD and bundle cleanliness. */
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const cli = process.env.ALWITH_DEV_CLI
const project = process.env.ALWITH_DEV_PROJECT
const server = process.env.ALWITH_DEV_SERVER
const dryRun = process.argv.includes("--dry-run")
if (!cli || !existsSync(cli)) throw new Error("Set ALWITH_DEV_CLI to alwith.dev/cli/src/main.ts (the official CLI).")
if (!project) throw new Error("Set ALWITH_DEV_PROJECT to the registered alwith.dev project slug.")
if (!dryRun && (!server || !process.env.ALWITH_DEV_TOKEN))
  throw new Error("Set ALWITH_DEV_SERVER and ALWITH_DEV_TOKEN before publishing.")
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
const args = [
  "bun",
  cli,
  "upload",
  "storybook",
  "--static-dir",
  resolve(root, "storybook-static"),
  "--source-dir",
  root,
  "--project",
  project
]
// The official CLI derives exact commit / branch / merge-base metadata in CI.
if (!process.env.GITHUB_ACTIONS && !process.env.GITLAB_CI) {
  args.push("--commit", git("rev-parse", "HEAD"), "--branch", git("symbolic-ref", "--short", "HEAD"))
}
if (server) args.push("--server", server)
if (dryRun) args.push("--dry-run")
const child = Bun.spawn(args, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
process.exit(await child.exited)
