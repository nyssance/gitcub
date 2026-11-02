import { Channel, invoke } from "@tauri-apps/api/core"
import { Emitter } from "event-kit"

import { getReleaseSummary } from "./release-notes"

type UpdateEvent =
  | { kind: "checking" | "not-available" | "downloaded" }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "error"; message: string }
const emitter = new Emitter()
let latestRelease: { version: string; notes: string | null } | undefined
export const getUpdatesEndpoint = () => invoke<string | null>("updater_endpoint")
export const onAutoUpdaterCheckingForUpdate = (fn: () => void) => emitter.on("checking", fn)
export const onAutoUpdaterUpdateAvailable = (fn: () => void) => emitter.on("available", fn)
export const onAutoUpdaterUpdateDownloaded = (fn: () => void) => emitter.on("downloaded", fn)
export const onAutoUpdaterUpdateNotAvailable = (fn: () => void) => emitter.on("not-available", fn)
export const onAutoUpdaterError = (fn: (event: unknown, error: Error) => void) =>
  emitter.on("error", (error: Error) => fn(undefined, error))

export async function checkForUpdates(_url: string): Promise<Error | undefined> {
  const events = new Channel<UpdateEvent>()
  let notifiedError = false
  events.onmessage = event => {
    if (event.kind === "available") latestRelease = event
    if (event.kind === "error") {
      notifiedError = true
      emitter.emit("error", new Error(event.message))
    } else emitter.emit(event.kind)
  }
  try {
    await invoke("updater_check", { events })
  } catch (error) {
    if (!notifiedError) return new Error(String(error))
  }
}
export async function generateReleaseSummary() {
  return latestRelease
    ? [
        getReleaseSummary({
          name: latestRelease.version,
          version: latestRelease.version,
          pub_date: new Date().toISOString(),
          notes: latestRelease.notes?.split("\n") ?? []
        })
      ]
    : null
}
export const isRunningUnderARM64Translation = async () => (await invoke<string>("app_architecture")) === "x64-emulated"
export function quitAndInstallUpdate() {
  void invoke("install_update").catch(error => emitter.emit("error", new Error(String(error))))
}
// The Rust install command performs the exit-guard transition atomically with
// installation; no separate synchronous Electron IPC permission is needed.
export const quitApp = (force: boolean) => invoke("request_quit", { force })
export const cancelQuittingApp = () => invoke("cancel_quit")
