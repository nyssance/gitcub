import type { ITokens } from "@/upstream/lib/highlighter/types"

import type { HighlightRequest, HighlightResponse } from "./worker"

/** 词法分析的客户端：把活派给 worker，主线程不阻塞。
 *
 * 原版同样是 worker（app/src/highlighter/，CodeMirror 5 runmode）。
 * 关键点是**两侧完整文件分别分析**——统一 diff 不是合法源码，
 * 整个喂给解析器 token 会被切错。 */

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, (tokens: ITokens | undefined) => void>()

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
  worker.onmessage = (e: MessageEvent<HighlightResponse>) => {
    const resolve = pending.get(e.data.id)
    if (resolve) {
      pending.delete(e.data.id)
      resolve(e.data.tokens ?? undefined)
    }
  }
  worker.onerror = () => {
    // worker 起不来就整体降级为不上色
    for (const resolve of pending.values()) resolve(undefined)
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

export function tokenizeFile(content: string, path: string): Promise<ITokens | undefined> {
  if (content.length === 0) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const id = nextId++
    pending.set(id, resolve)
    const req: HighlightRequest = { id, path, content }
    ensureWorker().postMessage(req)
  })
}
