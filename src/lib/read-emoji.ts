import type { Emoji } from "../upstream/lib/emoji"
import { Tokenizer, TokenType } from "./text-token-parser"

/**
 * Desktop read-emoji.ts：把 gemoji 列表读成 `:alias:` → Emoji，键排序后放进 Map。
 *
 * 数据来自 npm 的 gemoji（与 Desktop 子模块 github/gemoji 同源），只有 Unicode emoji，
 * 用字符渲染，不带 PNG；`:shipit:` 这类 GitHub 自有 emoji 不在其中。
 */
export async function readEmoji(): Promise<Map<string, Emoji>> {
  const { gemoji } = await import("gemoji")
  const tmp = new Map<string, Emoji>()
  for (const emoji of gemoji) {
    for (const alias of emoji.names) {
      tmp.set(`:${alias}:`, { emoji: emoji.emoji, aliases: emoji.names, description: emoji.description, url: "" })
    }
  }
  return new Map([...tmp.keys()].toSorted().map(key => [key, tmp.get(key)!]))
}

/** Desktop RichText 里 emoji 那一步：Tokenizer 认出的 `:alias:` 换成字符，其余文字原样 */
export function emojify(text: string, emoji: Map<string, Emoji>): string {
  if (emoji.size === 0 || !text.includes(":")) return text
  return new Tokenizer(emoji)
    .tokenize(text)
    .map(token => (token.kind === TokenType.Emoji ? (token.emoji ?? token.text) : token.text))
    .join("")
}
