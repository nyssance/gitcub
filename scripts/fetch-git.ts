import { spawnSync } from "node:child_process"
// 下载随包分发的 git（desktop/dugite-native，GitHub Desktop 用的同一个源），与 fabfile 的
// `fab git-download` 同一套逻辑，供 CI 使用（CI 不装 Fabric）。跟随 dugite 的清单，不自己维护 URL。
//
//   bun scripts/fetch-git.ts            # 当前平台
//   bun scripts/fetch-git.ts darwin-arm64 win32-x64
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const MANIFEST = "https://raw.githubusercontent.com/desktop/dugite/main/script/embedded-git.json"
const destination = resolve(import.meta.dirname, "../src-tauri/resources/git")

// Git Credential Manager 及其 .NET 运行时：我们用自己的 GIT_ASKPASS，用不上，独占 107MB。
const gcmPatterns = [
  /\.dll$/,
  /\.json$/,
  /^git-credential-manager/,
  /^libSkiaSharp\./,
  /^libHarfBuzzSharp\./,
  /^libcoreclr\./,
  /^libclrjit\./,
  /^libhostfxr\./,
  /^libhostpolicy\./,
  /^libSystem\./,
  /^libmscordaccore\./,
  /^libmscordbi\./,
  /^createdump$/
]
// 客户端用不到的组件。git-http-backend 和 git-shell 是服务端的。
const unusedBinaries = [
  "bin/scalar",
  "libexec/git-core/scalar",
  "libexec/git-core/git-http-backend",
  "libexec/git-core/git-shell",
  "libexec/git-core/git-imap-send",
  "libexec/git-core/git-http-push",
  "libexec/git-core/git-cvsserver",
  "libexec/git-core/git-daemon"
]

function platformKey() {
  const system = { darwin: "darwin", win32: "win32", linux: "linux" }[process.platform as "darwin" | "win32" | "linux"]
  const arch = { x64: "x64", arm64: "arm64" }[process.arch as "x64" | "arm64"] ?? process.arch
  return `${system}-${arch}`
}

/** 剥掉用不到的部分：148MB → 28MB。 */
function slim(target: string) {
  const core = join(target, "libexec/git-core")
  let freed = 0
  if (existsSync(core)) {
    for (const name of readdirSync(core)) {
      if (!gcmPatterns.some(pattern => pattern.test(name))) continue
      const path = join(core, name)
      const info = lstatSync(path)
      freed += info.isFile() ? info.size : 0
      rmSync(path, { recursive: true, force: true })
    }
  }
  for (const relative of unusedBinaries) {
    const path = join(target, relative)
    if (existsSync(path) && statSync(path).isFile()) {
      freed += statSync(path).size
      unlinkSync(path)
    }
  }
  for (const relative of ["share/bash-completion", "share/man", "doc"])
    rmSync(join(target, relative), { recursive: true, force: true })
  console.log(`  剥掉 GCM 与服务端组件：省 ${Math.round(freed / 1024 / 1024)}MB`)
  // 删掉指向 git 自身的兼容符号链接：Tauri 打包资源时会跟随符号链接，每个链接被复制成完整副本。
  let links = 0
  if (existsSync(core)) {
    for (const name of readdirSync(core)) {
      const path = join(core, name)
      if (lstatSync(path).isSymbolicLink() && readlinkSync(path).split("/").at(-1) === "git") {
        unlinkSync(path)
        links += 1
      }
    }
  }
  if (links) console.log(`  删掉 ${links} 个 git-* 兼容符号链接`)
}

const manifest = (await (await fetch(MANIFEST)).json()) as Record<
  string,
  { name: string; url: string; checksum: string }
>
const keys = process.argv.length > 2 ? process.argv.slice(2) : [platformKey()]
for (const key of keys) {
  const entry = manifest[key]
  if (!entry) {
    console.log(`${key} 不在 dugite 清单里，跳过`)
    continue
  }
  console.log(key)
  const target = join(destination, key)
  const scratch = join(tmpdir(), `gitcub-git-${key}-${process.pid}`)
  mkdirSync(scratch, { recursive: true })
  try {
    const archive = join(scratch, entry.name)
    const bytes = new Uint8Array(await (await fetch(entry.url)).arrayBuffer())
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (digest !== entry.checksum) throw new Error(`校验和不匹配\n  期望 ${entry.checksum}\n  实际 ${digest}`)
    console.log("  校验和 ✅")
    writeFileSync(archive, bytes)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    const tar = spawnSync("tar", ["-xf", archive, "-C", target], { stdio: "inherit" })
    if (tar.status !== 0) throw new Error(`解压 ${entry.name} 失败`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  slim(target)
  let size = 0
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const info = lstatSync(path)
      if (info.isDirectory()) walk(path)
      else size += info.size
    }
  }
  walk(target)
  console.log(`  → ${target}  ${Math.round(size / 1024 / 1024)}MB`)
}
