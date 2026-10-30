import type { EventEmitter } from "node:events"
// Winston stream API shape only. Date is supplied at the clock boundary so the
// original mocked dates exercise Rust rotation, file writes and retention.
import { Writable } from "node:stream"

import { call } from "./bridge"
export class DesktopFileTransport extends Writable {
  constructor(private readonly options: { logDirectory: string }) {
    super({ objectMode: true })
  }
  _write(info: Record<symbol, string>, _encoding: string, callback: (error?: Error | null) => void) {
    try {
      call("log/write", {
        directory: this.options.logDirectory,
        timestamp: Date.now(),
        message: info[Symbol.for("message")]
      })
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }
  close(callback?: () => void) {
    this.end(callback)
  }
}
export function installBrokenPipeErrorHandler(stream: EventEmitter) {
  stream.on("error", (error: Error & { code?: string }) => {
    if (!call("log/broken-pipe", { code: error.code ?? "" })) throw error
  })
}
