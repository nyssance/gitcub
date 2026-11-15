// The machine a benchmark report was taken on, shared by `benchmark.ts` and `bench-app.ts`.
import { loadavg } from "node:os"

function sysctl(key: string) {
  const result = Bun.spawnSync(["sysctl", "-n", key], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

export function machine() {
  const darwin = process.platform === "darwin"
  const git = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" })
  return {
    platform: process.platform,
    arch: process.arch,
    model: darwin ? sysctl("hw.model") : null,
    cpu: darwin ? sysctl("machdep.cpu.brand_string") : null,
    memoryBytes: darwin ? Number(sysctl("hw.memsize")) : null,
    os: darwin ? sysctl("kern.osproductversion") : null,
    git: git.exitCode === 0 ? git.stdout.toString().trim() : null,
    /** 1, 5 and 15 minute load averages when the report was written. */
    loadAverage: loadavg().map(value => Math.round(value * 100) / 100)
  }
}
