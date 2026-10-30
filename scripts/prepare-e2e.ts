import { spawnSync } from "node:child_process"

// Exercise the packaged production renderer. macOS native notifications require
// a real application bundle, so cargo build alone is not an E2E build.
const cli = spawnSync("tauri-hasgard", ["--version"], { stdio: "inherit" })
if (cli.error || cli.status !== 0) {
  throw new Error("Install the E2E driver with: cargo install tauri-hasgard --version '^0.5' --locked")
}
const build = spawnSync(
  "bun",
  [
    "run",
    "tauri",
    "build",
    "--debug",
    "--features",
    "hasgard-testing",
    "--bundles",
    process.platform === "darwin" ? "app" : "none",
    // 测试包不出更新器产物：生产配置开了 createUpdaterArtifacts，没有签名私钥时 tauri build 会直接失败
    "--config",
    JSON.stringify({ bundle: { createUpdaterArtifacts: false } })
  ],
  { stdio: "inherit" }
)
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)
