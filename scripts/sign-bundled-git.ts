// 打包前给随包分发的 git 里的每个 Mach-O 签名（hardened runtime + 时间戳）。dugite-native 的二进制
// 只有 ad-hoc 签名，Tauri 只签主程序和框架，不签资源目录，公证会因此拒绝整个包。
// 由 tauri.conf.json 的 beforeBundleCommand 调用；没有 APPLE_SIGNING_IDENTITY（本地未签名构建、CI 测试包）时什么都不做。
import { spawnSync } from "node:child_process"
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs"
import { join, resolve } from "node:path"

const identity = process.env.APPLE_SIGNING_IDENTITY
if (!identity || process.platform !== "darwin") process.exit(0)

const root = resolve(import.meta.dirname, "../src-tauri/resources/git/darwin-arm64")
const magics = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe])
const isMachO = (path: string) => {
  const fd = openSync(path, "r")
  try {
    const header = Buffer.alloc(4)
    return readSync(fd, header, 0, 4, 0) === 4 && magics.has(header.readUInt32BE(0))
  } finally {
    closeSync(fd)
  }
}
const files: string[] = []
const walk = (directory: string) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const info = lstatSync(path)
    if (info.isDirectory()) walk(path)
    else if (info.isFile() && isMachO(path)) files.push(path)
  }
}
walk(root)
for (const file of files) {
  const result = spawnSync("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", identity, file], {
    stdio: "inherit"
  })
  if (result.status !== 0) throw new Error(`签名失败：${file}`)
}
console.log(`已用 ${identity} 签名 ${files.length} 个随包 git 二进制`)
