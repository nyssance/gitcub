// line comment
import { readFile } from "node:fs/promises"

/* block comment
   spanning lines */
export async function main(path = "./a.txt", ...rest) {
  const n = 0x1f + 3.5e2
  let re = /a+b/gi, tpl = `multi ${n}
line ${rest.length}`
  class Foo extends Bar {
    static #x = 1
    get y() { return this.#x ?? null }
  }
  label: for (const k of rest) { if (k === undefined) break label }
  return await readFile(path, { encoding: "utf8" })
}
