import { invoke } from "@tauri-apps/api/core"
import { homeDir } from "@tauri-apps/api/path"

let homeDirectory: string | undefined
let workingDirectory: string | undefined
export async function initializePlatformEnvironment() {
  ;[workingDirectory, homeDirectory] = await Promise.all([invoke<string>("working_directory"), homeDir()])
}
export function getWorkingDirectory(): string {
  if (workingDirectory === undefined) throw new Error("Native environment has not been initialized")
  return workingDirectory
}

export function getHomeDirectory(): string {
  if (homeDirectory === undefined) throw new Error("Native environment has not been initialized")
  return homeDirectory
}
