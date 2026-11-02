/// <reference lib="webworker" />

/** 词法分析 worker。
 *
 * 原版也是把高亮放在独立 worker 里（app/src/highlighter/，CodeMirror 5 的
 * runmode）。放主线程的话，几万行的文件会把界面卡住——这正是我们要避开的
 * GitHub Desktop 老毛病。
 *
 * 这里直接用 Lezer 语法树，输出 class 名沿用 lezer 的 `tok-*`。
 * 不建 EditorState：worker 只要语法树，@codemirror/language 会把整个
 * @codemirror/view 拖进来。 */

import { classHighlighter, highlightTree } from "@lezer/highlight"

import { languageOf } from "@/lib/codemirror-language"
import type { ITokens } from "@/upstream/lib/highlighter/types"

export interface HighlightRequest {
  id: number
  path: string
  content: string
}

export interface HighlightResponse {
  id: number
  tokens: ITokens | null
}

/** 超过这个大小就不分析：再大解析本身也慢，而且 diff 通常也看不完。 */
const MAX_BYTES = 2 * 1024 * 1024

/** 解析超时就放弃，与之前 ensureSyntaxTree 的超时一致。 */
const PARSE_TIMEOUT_MS = 10_000

/** 与 CodeMirror 的 Text 一致：`\r\n`、`\r`、`\n` 都算换行，行内不含换行符，
 *  解析用的位置按每个换行占一个字符计算。 */
const LINE_BREAK = /\r\n?|\n/

export function tokenize(content: string, path: string): ITokens | null {
  if (content.length > MAX_BYTES) return null

  const parser = languageOf(path)
  if (parser === null) return null

  const lines = content.split(LINE_BREAK)
  const parse = parser.startParse(lines.join("\n"))
  const deadline = Date.now() + PARSE_TIMEOUT_MS
  let tree = parse.advance()
  while (tree === null) {
    if (Date.now() > deadline) return null
    tree = parse.advance()
  }

  // 每行的起始位置，按位置二分找所在行
  const lineStarts: number[] = []
  for (let i = 0, pos = 0; i < lines.length; i++) {
    lineStarts.push(pos)
    pos += lines[i].length + 1
  }
  const lineAt = (pos: number): number => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (lineStarts[mid] <= pos) low = mid
      else high = mid - 1
    }
    return low
  }

  const tokens: ITokens = {}

  highlightTree(tree, classHighlighter, (from, to, classes) => {
    // 跨行的 token（块注释、模板字符串）按行切开，ITokens 是按行组织的
    let start = from
    let line = lineAt(from)
    while (start < to) {
      const lineFrom = lineStarts[line]
      const end = Math.min(to, lineFrom + lines[line].length)
      // 这一行还没有桶就先建一个。合成一句 `??=` 更短，但赋值藏在表达式里
      tokens[line] ??= {}
      const bucket = tokens[line]
      bucket[start - lineFrom] = { length: end - start, token: classes }
      start = end + 1 // 跳过换行符
      if (start >= to) break
      line = lineAt(start)
    }
  })

  return tokens
}

self.onmessage = (e: MessageEvent<HighlightRequest>) => {
  const { id, path, content } = e.data
  let tokens: ITokens | null
  try {
    tokens = tokenize(content, path)
  } catch {
    // 解析失败就不上色，不该让整个 diff 挂掉
    tokens = null
  }
  const res: HighlightResponse = { id, tokens }
  self.postMessage(res)
}
