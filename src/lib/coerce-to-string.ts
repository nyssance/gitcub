import type { Buffer } from "node:buffer"
// Desktop MIT port; platform imports adapted.
export const coerceToString = (value: string | Buffer, encoding: BufferEncoding = "utf8") =>
  typeof value !== "string" ? value.toString(encoding) : value
