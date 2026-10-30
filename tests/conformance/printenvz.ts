// Original helper path comes from the production embedded upstream C program.
// The bridge process exits after each request. For this synchronous test-only
// path getter use the build artifact; packaged production uses its live helper.
import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
export function getPrintenvzPath() {
  const builds = join(process.cwd(), "src-tauri/target/debug/build")
  for (const name of readdirSync(builds)) {
    if (!name.startsWith("gitcub-")) continue
    const path = join(builds, name, "out", process.platform === "win32" ? "printenvz.exe" : "printenvz")
    try {
      execFileSync(path)
      return path
    } catch {
      // Try the next executable candidate when this platform cannot run it.
    }
  }
  throw new Error("Compiled upstream printenvz helper not found")
}
