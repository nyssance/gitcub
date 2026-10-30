// Desktop 的数据库层原版建在 Dexie/IndexedDB 上。用户于 2026-10-26 决定去掉 Dexie：
// 数据改放 Rust 侧的命名 JSON 存储（参考 ALwith Desktop 的 alwith-module-store），
// 一个数据库对应一个 store，一张表对应一个键，随应用数据目录备份、各平台落盘位置一致。
//
// 这里只保留 Desktop store 代码与原版测试实际用到的 Dexie 表 API 子集，
// 表定义沿用 Dexie 的 schema 字符串（`++id`、`&path`、`[a+b]`），内存为准、写穿到存储：
// - 读写都先等库打开，然后同步作用于内存；写入按库串行、同一张表的连续写合并成一次落盘。
// - `transaction()` 按库排队：同一时刻只跑一个顶层事务，并发的读-改-写（统计计数累加）不会互相覆盖。
//   没有 Dexie 的 zone 就认不出嵌套调用，所以排队的事务还会在 JS 任务队列空转时被放行 ——
//   父事务 await 子事务时只有这一条路不死锁；代价是父事务等待 IPC 落盘期间可能有别的事务插进来，
//   和 Dexie“事务内 await 非数据库 promise 即提交”的规则同一量级。
// - 原版的 schema 版本迁移不再存在：命名存储从空表起步，没有 IndexedDB 旧数据可迁。
import { type AlwithStore, openStore, type StoreScope } from "../store"

type KeyPath = string | readonly string[]

interface IndexSpec {
  /** Dexie 语法里的索引名，复合索引保留方括号，`where("[a+b]")` 用它查 */
  readonly name: string
  readonly keyPath: KeyPath
  readonly unique: boolean
  readonly auto: boolean
}

interface Row<T> {
  readonly key: unknown
  value: T
}

interface TableData<T> {
  readonly nextId: number
  readonly rows: ReadonlyArray<Row<T>>
}

/** 数据库只需要表的名字和序列化/装载入口，不关心记录类型 */
interface StoredTable {
  readonly name: string
  load(data: TableData<unknown> | undefined): void
  toJSON(): TableData<unknown>
}

function parseIndex(spec: string): IndexSpec {
  let text = spec.trim()
  let unique = false
  let auto = false
  if (text.startsWith("&")) {
    unique = true
    text = text.slice(1)
  }
  if (text.startsWith("++")) {
    auto = true
    text = text.slice(2)
  }
  const keyPath: KeyPath = text.startsWith("[") ? text.slice(1, -1).split("+") : text
  return { name: text, keyPath, unique, auto }
}

function valueAt(record: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], record)
}

function setAt(record: object, path: string, value: unknown) {
  const parts = path.split(".")
  const last = parts.pop()!
  const target = parts.reduce<Record<string, unknown>>(
    (current, part) => {
      current[part] ??= {}
      return current[part] as Record<string, unknown>
    },
    record as Record<string, unknown>
  )
  target[last] = value
}

function keyOf(record: unknown, keyPath: KeyPath): unknown {
  return typeof keyPath === "string" ? valueAt(record, keyPath) : keyPath.map(path => valueAt(record, path))
}

function keyString(key: unknown) {
  return JSON.stringify(key)
}

function rank(value: unknown) {
  if (typeof value === "number") return 0
  if (value instanceof Date) return 1
  if (typeof value === "string") return 2
  if (Array.isArray(value)) return 3
  return -1
}

/** IndexedDB 的键序：数字 < 日期 < 字符串 < 数组，数组逐项比较、短的在前 */
export function compareKeys(a: unknown, b: unknown): number {
  const rankA = rank(a)
  const rankB = rank(b)
  if (rankA !== rankB) return rankA - rankB
  switch (rankA) {
    case 0:
      return (a as number) - (b as number)
    case 1:
      return (a as Date).getTime() - (b as Date).getTime()
    case 2:
      return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0
    case 3: {
      const left = a as unknown[]
      const right = b as unknown[]
      for (let index = 0; index < Math.min(left.length, right.length); index++) {
        const result = compareKeys(left[index], right[index])
        if (result !== 0) return result
      }
      return left.length - right.length
    }
    default:
      return 0
  }
}

/** IndexedDB 不给无效键（undefined/null/布尔）建索引，原版靠这一点排除缺字段的记录 */
function isValidKey(key: unknown): boolean {
  const kind = rank(key)
  return kind === 3 ? (key as unknown[]).every(isValidKey) : kind >= 0
}

/** 宏任务：MessageChannel 不受测试假时钟影响，WebView 和 Bun 都有 */
function macrotask(callback: () => void) {
  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    channel.port1.close()
    callback()
  }
  channel.port2.postMessage(undefined)
}

export class ConstraintError extends Error {
  public override readonly name = "ConstraintError"
}

export class Collection<T> {
  public constructor(
    private readonly table: Table<T, unknown>,
    private readonly source: () => ReadonlyArray<Row<T>>,
    private readonly predicate?: (value: T) => boolean,
    private readonly max?: number
  ) {}

  private async rows() {
    await this.table.database.open()
    let rows = this.source()
    if (this.predicate) rows = rows.filter(row => this.predicate!(row.value))
    if (this.max !== undefined) rows = rows.slice(0, this.max)
    return rows
  }

  public async toArray(): Promise<T[]> {
    return (await this.rows()).map(row => row.value)
  }

  public async first(): Promise<T | undefined> {
    return (await this.rows())[0]?.value
  }

  public async last(): Promise<T | undefined> {
    return (await this.rows()).at(-1)?.value
  }

  public async count() {
    return (await this.rows()).length
  }

  public async each(callback: (value: T) => unknown) {
    for (const row of await this.rows()) await callback(row.value)
  }

  public filter(predicate: (value: T) => boolean) {
    const previous = this.predicate
    return new Collection<T>(
      this.table,
      this.source,
      previous ? value => previous(value) && predicate(value) : predicate,
      this.max
    )
  }

  public limit(count: number) {
    return new Collection<T>(this.table, this.source, this.predicate, count)
  }

  public async delete(): Promise<number> {
    const rows = await this.rows()
    for (const row of rows) this.table.removeRow(row)
    if (rows.length > 0) await this.table.persist()
    return rows.length
  }

  public async modify(changes: Partial<T> | ((value: T) => void)): Promise<number> {
    const rows = await this.rows()
    for (const row of rows) {
      this.table.removeRow(row)
      if (typeof changes === "function") changes(row.value)
      else Object.assign(row.value as object, changes)
      this.table.insertRow(row.key, row.value)
    }
    if (rows.length > 0) await this.table.persist()
    return rows.length
  }
}

export class WhereClause<T> {
  public constructor(
    private readonly table: Table<T, unknown>,
    private readonly index: IndexSpec
  ) {}

  public equals(value: unknown) {
    return new Collection<T>(this.table, () => this.table.rowsByIndex(this.index, value))
  }

  public between(lower: unknown, upper: unknown, includeLower = true, includeUpper = false) {
    return new Collection<T>(this.table, () =>
      this.table.rowsInRange(this.index, key => {
        const low = compareKeys(key, lower)
        const high = compareKeys(key, upper)
        return (includeLower ? low >= 0 : low > 0) && (includeUpper ? high <= 0 : high < 0)
      })
    )
  }
}

export class Table<T, Key = unknown> {
  private readonly primary: IndexSpec
  private readonly indexes: ReadonlyArray<IndexSpec>
  private rows = new Map<string, Row<T>>()
  private indexMaps = new Map<string, Map<string, Set<string>>>()
  private nextId = 1

  public constructor(
    public readonly database: BaseDatabase,
    public readonly name: string,
    schema: string
  ) {
    const specs = schema.split(",").map(parseIndex)
    this.primary = specs[0]!
    this.indexes = specs.slice(1)
    for (const index of this.indexes) this.indexMaps.set(index.name, new Map())
  }

  // ---- 存储格式：{ nextId, rows: [{ key, value }] }，undefined 字段落盘时自然丢掉 ----

  public load(data: TableData<T> | undefined) {
    this.rows = new Map()
    for (const map of this.indexMaps.values()) map.clear()
    this.nextId = data?.nextId ?? 1
    for (const row of data?.rows ?? []) this.insertRow(row.key, row.value)
  }

  public toJSON(): TableData<T> {
    return { nextId: this.nextId, rows: [...this.rows.values()] }
  }

  public persist() {
    return this.database.persist(this)
  }

  // ---- 内存行维护（同步） ----

  public insertRow(key: unknown, value: T) {
    const id = keyString(key)
    this.rows.set(id, { key, value })
    for (const index of this.indexes) {
      const indexKey = keyOf(value, index.keyPath)
      if (!isValidKey(indexKey)) continue
      const bucket = this.indexMaps.get(index.name)!
      const entry = keyString(indexKey)
      let members = bucket.get(entry)
      if (!members) bucket.set(entry, (members = new Set()))
      members.add(id)
    }
  }

  public removeRow(row: Row<T>) {
    const id = keyString(row.key)
    this.rows.delete(id)
    for (const index of this.indexes) {
      const indexKey = keyOf(row.value, index.keyPath)
      if (!isValidKey(indexKey)) continue
      const bucket = this.indexMaps.get(index.name)!
      const entry = keyString(indexKey)
      const members = bucket.get(entry)
      members?.delete(id)
      if (members?.size === 0) bucket.delete(entry)
    }
  }

  private orderedByPrimary(rows: Iterable<Row<T>>) {
    return [...rows].toSorted((a, b) => compareKeys(a.key, b.key))
  }

  public rowsByIndex(index: IndexSpec, value: unknown): ReadonlyArray<Row<T>> {
    if (index === this.primary) {
      const row = this.rows.get(keyString(value))
      return row ? [row] : []
    }
    const members = this.indexMaps.get(index.name)!.get(keyString(value))
    return members ? this.orderedByPrimary([...members].map(id => this.rows.get(id)!)) : []
  }

  public rowsInRange(index: IndexSpec, inRange: (key: unknown) => boolean): ReadonlyArray<Row<T>> {
    const matches: Array<{ indexKey: unknown; row: Row<T> }> = []
    for (const row of this.rows.values()) {
      const indexKey = index === this.primary ? row.key : keyOf(row.value, index.keyPath)
      if (isValidKey(indexKey) && inRange(indexKey)) matches.push({ indexKey, row })
    }
    return matches
      .toSorted((a, b) => compareKeys(a.indexKey, b.indexKey) || compareKeys(a.row.key, b.row.key))
      .map(match => match.row)
  }

  private indexNamed(name: string) {
    const index = name === this.primary.name ? this.primary : this.indexes.find(index => index.name === name)
    if (!index) throw new Error(`${this.name} has no index ${name}`)
    return index
  }

  /** 原版 `++id`：记录没带主键就分配一个，并像 Dexie 一样写回传入的对象 */
  private prepareKey(record: T): unknown {
    if (!this.primary.auto) return keyOf(record, this.primary.keyPath)
    const keyPath = this.primary.keyPath as string
    if (keyPath === "") return this.nextId++
    const existing = valueAt(record, keyPath)
    if (typeof existing === "number") {
      this.nextId = Math.max(this.nextId, existing + 1)
      return existing
    }
    const id = this.nextId++
    setAt(record as object, keyPath, id)
    return id
  }

  private assertUnique(record: T, id: string) {
    for (const index of this.indexes) {
      if (!index.unique) continue
      const indexKey = keyOf(record, index.keyPath)
      if (!isValidKey(indexKey)) continue
      const members = this.indexMaps.get(index.name)!.get(keyString(indexKey))
      if (members && (members.size > 1 || !members.has(id))) {
        throw new ConstraintError(`${this.name}: duplicate ${index.name} ${keyString(indexKey)}`)
      }
    }
  }

  private store(record: T, replace: boolean): Key {
    const key = this.prepareKey(record)
    const id = keyString(key)
    const current = this.rows.get(id)
    if (current && !replace) throw new ConstraintError(`${this.name}: key ${id} already exists`)
    if (current) this.removeRow(current)
    this.insertRow(key, structuredClone(record))
    try {
      this.assertUnique(record, id)
    } catch (error) {
      this.removeRow(this.rows.get(id)!)
      if (current) this.insertRow(current.key, current.value)
      throw error
    }
    return key as Key
  }

  // ---- Dexie Table API 子集 ----

  public async get(keyOrCriteria: Key | Partial<T>): Promise<T | undefined> {
    await this.database.open()
    if (typeof keyOrCriteria === "object" && keyOrCriteria !== null && !Array.isArray(keyOrCriteria)) {
      const criteria = Object.entries(keyOrCriteria)
      const [name, value] = criteria[0]!
      const index = criteria.length === 1 ? this.indexes.find(index => index.name === name) : undefined
      const candidates = index ? this.rowsByIndex(index, value) : this.rows.values()
      for (const row of candidates) {
        if (criteria.every(([property, expected]) => valueAt(row.value, property) === expected)) return row.value
      }
      return undefined
    }
    return this.rows.get(keyString(keyOrCriteria))?.value
  }

  public async put(record: T): Promise<Key> {
    await this.database.open()
    const key = this.store(record, true)
    await this.persist()
    return key
  }

  public async add(record: T): Promise<Key> {
    await this.database.open()
    const key = this.store(record, false)
    await this.persist()
    return key
  }

  public async update(key: Key, changes: Partial<T>): Promise<number> {
    await this.database.open()
    const row = this.rows.get(keyString(key))
    if (!row) return 0
    this.removeRow(row)
    this.insertRow(row.key, { ...row.value, ...changes })
    await this.persist()
    return 1
  }

  public async delete(key: Key) {
    await this.database.open()
    const row = this.rows.get(keyString(key))
    if (!row) return
    this.removeRow(row)
    await this.persist()
  }

  public async bulkPut(records: ReadonlyArray<T>) {
    await this.database.open()
    for (const record of records) this.store(record, true)
    if (records.length > 0) await this.persist()
  }

  public async bulkAdd(records: ReadonlyArray<T>) {
    await this.database.open()
    for (const record of records) this.store(record, false)
    if (records.length > 0) await this.persist()
  }

  public async bulkDelete(keys: ReadonlyArray<Key>) {
    await this.database.open()
    for (const key of keys) {
      const row = this.rows.get(keyString(key))
      if (row) this.removeRow(row)
    }
    if (keys.length > 0) await this.persist()
  }

  public async clear() {
    await this.database.open()
    this.load(undefined)
    await this.persist()
  }

  public toCollection() {
    return new Collection<T>(this as Table<T, unknown>, () => this.orderedByPrimary(this.rows.values()))
  }

  public toArray() {
    return this.toCollection().toArray()
  }

  public count() {
    return this.toCollection().count()
  }

  public limit(count: number) {
    return this.toCollection().limit(count)
  }

  public filter(predicate: (value: T) => boolean) {
    return this.toCollection().filter(predicate)
  }

  public where(indexName: string) {
    return new WhereClause<T>(this as Table<T, unknown>, this.indexNamed(indexName))
  }
}

export abstract class BaseDatabase {
  private readonly store: AlwithStore
  private readonly tables = new Map<string, StoredTable>()
  private opening: Promise<void> | undefined
  private opened = false
  private queue: Promise<void> = Promise.resolve()
  private readonly pending = new Set<StoredTable>()
  private activeTransactions = 0
  private readonly waitingTransactions: Array<() => void> = []
  private idleCheckScheduled = false

  public constructor(
    public readonly name: string,
    scope: StoreScope = "data"
  ) {
    this.store = openStore(name, scope)
  }

  /** 原版 Dexie 的 `version().stores()`；GitCub 没有版本迁移，只登记表 */
  protected table<T, Key>(name: string, schema: string): Table<T, Key> {
    const table = new Table<T, Key>(this, name, schema)
    this.tables.set(name, table)
    return table
  }

  public open(): Promise<void> {
    return (this.opening ??= (async () => {
      const entries = await this.store.entries<unknown>()
      const data = new Map(entries)
      for (const [name, table] of this.tables) table.load(data.get(name) as TableData<unknown> | undefined)
      this.opened = true
    })())
  }

  public close() {}

  public isOpen() {
    return this.opened
  }

  /** 原版删除整个 IndexedDB；这里清空命名存储，下一次操作重新打开 */
  public async delete() {
    await this.enqueue(() => this.store.clear())
    for (const table of this.tables.values()) table.load(undefined)
    this.opening = undefined
    this.opened = false
  }

  /** Dexie 事务签名：`transaction(mode, ...tables, scope)`。排队与嵌套规则见文件头。 */
  public async transaction<R>(_mode: string, ...args: [...tables: object[], scope: () => Promise<R> | R]): Promise<R> {
    await this.open()
    const scope = args.at(-1) as () => Promise<R> | R
    if (this.activeTransactions > 0) await this.waitForTurn()
    this.activeTransactions++
    try {
      return await scope()
    } finally {
      this.activeTransactions--
      if (this.activeTransactions === 0) this.waitingTransactions.shift()?.()
    }
  }

  private waitForTurn() {
    return new Promise<void>(resolve => {
      this.waitingTransactions.push(resolve)
      this.scheduleIdleCheck()
    })
  }

  /** 微任务都跑完、活动事务仍未结束，就只能是它在等排队中的子事务：放行队首 */
  private scheduleIdleCheck() {
    if (this.idleCheckScheduled) return
    this.idleCheckScheduled = true
    macrotask(() => {
      this.idleCheckScheduled = false
      this.waitingTransactions.shift()?.()
      if (this.waitingTransactions.length > 0) this.scheduleIdleCheck()
    })
  }

  private enqueue(job: () => Promise<void>) {
    const run = this.queue.then(job)
    this.queue = run.catch(() => {})
    return run
  }

  /** 同一张表的连续写合并成一次落盘，不同表按调用顺序串行 */
  public persist(table: StoredTable): Promise<void> {
    if (this.pending.has(table)) return this.queue
    this.pending.add(table)
    return this.enqueue(() => {
      this.pending.delete(table)
      return this.store.set(table.name, table.toJSON())
    })
  }
}
