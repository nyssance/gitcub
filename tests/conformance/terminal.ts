import { spawn } from "node:child_process"
import { Duplex, Readable, Transform, Writable } from "node:stream"

import { call, executable } from "./bridge"
export function createTerminalStream() {
  const child = spawn(executable, ["--terminal-stream"], { stdio: ["pipe", "pipe", "pipe"] })
  const stream = Duplex.fromWeb({ writable: Writable.toWeb(child.stdin), readable: Readable.toWeb(child.stdout) })
  let stderr = ""
  child.stderr.setEncoding("utf8").on("data", value => {
    stderr += value
  })
  child.on("error", error => stream.destroy(error))
  child.on("exit", code => {
    if (code !== 0) stream.destroy(new Error(stderr || `Terminal bridge exited ${code}`))
  })
  stream.on("close", () => {
    if (child.exitCode === null) child.kill()
  })
  return stream
}
export function createTailStream(capacity: number, options?: object) {
  if (!(capacity > 0)) throw new Error('The "capacity" argument must be greater than 0')
  const chunks: number[][] = []
  return new Transform({
    ...options,
    decodeStrings: true,
    transform(chunk, _encoding, callback) {
      chunks.push([...chunk])
      callback()
    },
    flush(callback) {
      try {
        callback(null, Buffer.from(call("terminal/tail", { capacity, chunks })))
      } catch (error) {
        callback(error as Error)
      }
    }
  })
}
