// Desktop MIT implementation extracted unchanged from lib/file-system.ts.

import type { Buffer } from "node:buffer"

import byline from "byline"
import { Disposable } from "event-kit"

import { Tailer } from "./tailer"
export function tailByLine(path: string, cb: (line: string) => void): Disposable {
  const tailer = new Tailer(path)

  const onErrorDisposable = tailer.onError(error => {
    log.warn(`Unable to tail path: ${path}`, error)
  })

  const onDataDisposable = tailer.onDataAvailable(stream => {
    byline(stream).on("data", (buffer: Buffer) => {
      if (onDataDisposable.disposed) {
        return
      }

      const line = buffer.toString()
      cb(line)
    })
  })

  tailer.start()

  return new Disposable(() => {
    onDataDisposable.dispose()
    onErrorDisposable.dispose()
    tailer.stop()
  })
}
