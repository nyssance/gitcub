// Dugite transport used only to build and inspect the upstream fixture server.
export { exec } from "./fixtures"
import { spawn as spawnProcess } from "node:child_process"
export const spawn = (args: readonly string[], cwd: string) => spawnProcess("git", args, { cwd })
