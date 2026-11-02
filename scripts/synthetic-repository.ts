// Deterministic repository with many tracked files and a dirty working tree, shared by the
// hot-path benchmark (`scripts/benchmark.ts`) and the application benchmark (`scripts/bench-app.ts`).
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

function run(command: string[]) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** `files` tracked files in 100-file directories, `commits` changes on top of the import, 603 working-tree changes. */
export function createSyntheticRepository(directory: string, files: number, commits: number) {
  const git = (...args: string[]) => run(["git", "-C", directory, ...args])
  mkdirSync(directory)
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Benchmark")
  git("config", "user.email", "benchmark@example.invalid")
  git("config", "commit.gpgsign", "false")
  const perDirectory = 100
  const paths: string[] = []
  const contents = new Map<string, string>()
  for (let i = 0; i < files; i++) {
    const path = `src/module-${String(Math.floor(i / perDirectory)).padStart(4, "0")}/file-${i % perDirectory}.ts`
    paths.push(path)
    contents.set(path, `export const value${i} = ${i}\n`)
  }
  let seed = 42
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648)
  const pick = () => paths[next() % paths.length]!
  // One fast-import stream builds the whole history without touching the index.
  const stream: string[] = []
  const blob = (path: string) => {
    const content = contents.get(path)!
    stream.push(`M 100644 inline ${path}`, `data ${Buffer.byteLength(content)}`, content)
  }
  const commit = (message: string, changed: Iterable<string>) => {
    stream.push(
      "commit refs/heads/main",
      "committer Benchmark <benchmark@example.invalid> 1700000000 +0000",
      `data ${Buffer.byteLength(message)}`,
      message
    )
    for (const path of changed) blob(path)
    stream.push("")
  }
  commit("Initial import", paths)
  for (let index = 0; index < commits; index++) {
    const changed = new Set<string>()
    for (let change = 0; change < 20; change++) {
      const path = pick()
      contents.set(path, `${contents.get(path)}// change ${index}\n`)
      changed.add(path)
    }
    commit(`Change ${index}`, changed)
  }
  const imported = Bun.spawnSync(["git", "-C", directory, "fast-import", "--quiet"], {
    stdin: new TextEncoder().encode(`${stream.join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe"
  })
  if (imported.exitCode !== 0) throw new Error(`git fast-import failed:\n${imported.stderr.toString()}`)
  git("reset", "-q", "--hard", "main")
  // 远端跟踪分支落后五个提交：本地未推送提交（`--not --remotes`、`upstream..branch`）有真实的排除端。
  git("update-ref", "refs/remotes/origin/main", "main~5")
  git("remote", "add", "origin", "https://git.example/bench/synthetic.git")
  const file = (path: string) => join(directory, path)
  const staged = new Set<string>()
  while (staged.size < 100) staged.add(pick())
  for (const path of staged) appendFileSync(file(path), "// staged\n")
  git("add", "--", ...staged)
  for (let i = 0; i < 200; i++) appendFileSync(file(pick()), "// unstaged\n")
  for (let i = 0; i < 300; i++) writeFileSync(join(directory, "src", `untracked-${i}.ts`), "export {}\n")
  for (let i = 0; i < 20; i++) rmSync(file(pick()), { force: true })
  // 三条贮藏：`stash create` 只写对象不动工作区，`stash store` 写 reflog，status 的工作量不变。
  for (const message of ["!!GitHub_Desktop<main>", "WIP on main: bench", "!!GitHub_Desktop<feature>"]) {
    git("stash", "store", "-m", message, git("stash", "create").trim())
  }
}
