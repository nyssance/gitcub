import { Buffer } from "node:buffer"
import { EventEmitter } from "node:events"

// Node fs surface consumed by the unchanged Desktop Tailer. Watches and file
// descriptors are owned by Rust; readable-stream supplies browser backpressure.
import { Channel, invoke } from "@tauri-apps/api/core"
import { Readable } from "readable-stream"

import { stat as metadata } from "./native-files"
export class FSWatcher extends EventEmitter {
  private closed = false
  private readonly ready: Promise<number>
  constructor(path: string, listener?: (event: string) => void) {
    super()
    const events = new Channel<{ event?: string; error?: string }>()
    if (listener) this.on("change", listener)
    events.onmessage = event => {
      if (this.closed) return
      if (event.error) this.emit("error", new Error(event.error))
      else this.emit("change", event.event)
    }
    this.ready = invoke<number>("tail_watch", { path, events })
    void this.ready.catch(error => {
      if (!this.closed) this.emit("error", asError(error))
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    void this.ready
      .then(id => invoke("tail_unwatch", { id }))
      .catch(error => log.warn("Unable to close file watcher", asError(error)))
  }
}
const asError = (error: unknown) =>
  error instanceof Error
    ? error
    : new Error(
        typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error)
      )
export const watch = (path: string, listener?: (event: string) => void) => new FSWatcher(path, listener)
export function stat(path: string, callback: (error: Error | null, stats: { size: number }) => void) {
  void metadata(path).then(
    value => callback(null, value),
    error => callback(asError(error), { size: 0 })
  )
}
export class ReadStream extends Readable {
  private position: number
  constructor(
    private readonly path: string,
    private readonly range: { start: number; end: number }
  ) {
    super()
    this.position = range.start
  }
  override _read(size: number) {
    const length = Math.min(size, 65536, this.range.end - this.position + 1)
    if (length <= 0) {
      this.push(null)
      return
    }
    void invoke<number[]>("tail_read", { path: this.path, position: this.position, length }).then(
      bytes => {
        if (this.destroyed) return
        this.position += bytes.length
        this.push(bytes.length === 0 ? null : Buffer.from(bytes))
      },
      error => this.destroy(asError(error))
    )
  }
}
export const createReadStream = (path: string, options: { start: number; end: number }) => new ReadStream(path, options)

export default { watch, stat, createReadStream }
