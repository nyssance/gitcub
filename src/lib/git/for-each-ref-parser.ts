// Desktop MIT: original ref-filter parser.
export function createForEachRefParser<T extends Record<string, string>>(fields: T) {
  const keys: Array<keyof T> = Object.keys(fields)
  const format = Object.values(fields).join("%00")
  const formatArgs = [`--format=%00${format}%00`]

  const parse = (value: string) => {
    const records = value.split("\0")
    const entries: { [K in keyof T]: string }[] = []

    // Preserve the original Desktop implementation and contract.
    let entry
    let consumed = 0

    // start at 1 to avoid 0 modulo X problem. The first record is guaranteed
    // to be empty anyway (due to %00 at the start of --format)
    for (let i = 1; i < records.length - 1; i++) {
      if (i % (keys.length + 1) === 0) {
        if (records[i] !== "\n") {
          throw new Error("Expected newline")
        }
        continue
      }

      entry ??= {} as { [K in keyof T]: string }
      const key = keys[consumed % keys.length]
      entry[key] = records[i]
      consumed++

      if (consumed % keys.length === 0) {
        entries.push(entry)
        entry = undefined
      }
    }

    return entries
  }

  return { formatArgs, parse }
}
