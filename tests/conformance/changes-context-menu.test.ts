// 自有回归：改动行右键菜单的条目、顺序、可用性和动作，对照 Desktop
// filter-changes-list.tsx:576-837 getDefaultContextMenu / getRebaseContextMenu 与 ui/lib/context-menu.ts。
import assert from "node:assert/strict"
import { it } from "node:test"

import {
  changesContextMenu,
  type ChangesMenuActions,
  type ChangesMenuContext,
  type ChangesMenuEntry,
  extname,
  fullPath
} from "../../src/lib/changes-context-menu"
import type { FileChange } from "../../src/models/repo-status"

const file = (path: string, change: FileChange["change"] = "modified", kind: FileChange["kind"] = "unstaged") =>
  ({ path, kind, change, oldPath: null, conflict: null, submodule: null }) as FileChange

const t = (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)

function harness(overrides: Partial<ChangesMenuContext> = {}) {
  const calls: unknown[][] = []
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push([name, ...args])
  const actions: ChangesMenuActions = {
    discard: record("discard"),
    ignoreFiles: record("ignoreFiles"),
    ignoreRule: record("ignoreRule"),
    includeChanged: (changed, include) => void calls.push(["includeChanged", changed.path, include]),
    copy: record("copy"),
    reveal: record("reveal"),
    openInEditor: record("openInEditor"),
    openWithDefault: record("openWithDefault")
  }
  const target = file("src/app/main.ts")
  const context: ChangesMenuContext = {
    repositoryPath: "/repo",
    file: target,
    files: [target],
    rebaseConflict: false,
    externalEditorLabel: null,
    platform: "macos",
    t,
    actions,
    ...overrides
  }
  return { calls, entries: changesContextMenu(context) }
}

const describe = (entries: ChangesMenuEntry[]): string[] =>
  entries.map(entry =>
    entry.type === "separator"
      ? "—"
      : entry.type === "submenu"
        ? `${entry.id}${entry.enabled ? "" : " (disabled)"} > [${entry.items.map(item => (item.type === "item" ? item.label : "?")).join(", ")}]`
        : `${entry.id}${entry.enabled ? "" : " (disabled)"}`
  )

const item = (entries: ChangesMenuEntry[], id: string) => {
  const found = entries.find(entry => entry.type !== "separator" && entry.id === id)
  assert.ok(found?.type === "item", id)
  return found
}

it("single file: Desktop order with ignore file, folder submenu, extension rule, copy and open items", () => {
  const { entries, calls } = harness()
  assert.deepEqual(describe(entries), [
    "discard",
    "—",
    "ignore-file",
    "ignore-folder > [/src/app, /src]",
    "ignore-extension:.ts",
    "—",
    "copy-path",
    "copy-relative-path",
    "—",
    "reveal",
    "open-in-editor",
    "open-with-default"
  ])
  assert.equal(item(entries, "discard").label, "changes.menu.discard")
  assert.equal(item(entries, "reveal").label, "changes.menu.revealInFinder")
  assert.equal(item(entries, "open-in-editor").label, "changes.menu.openInExternalEditor")
  item(entries, "discard").action()
  item(entries, "ignore-file").action()
  item(entries, "ignore-extension:.ts").action()
  item(entries, "copy-path").action()
  item(entries, "copy-relative-path").action()
  item(entries, "reveal").action()
  item(entries, "open-in-editor").action()
  item(entries, "open-with-default").action()
  const folder = entries.find(entry => entry.type === "submenu")!
  assert.equal(folder.type, "submenu")
  if (folder.type === "submenu" && folder.items[0].type === "item") folder.items[0].action()
  assert.deepEqual(calls, [
    ["discard", ["src/app/main.ts"]],
    ["ignoreFiles", ["src/app/main.ts"]],
    ["ignoreRule", "*.ts"],
    ["copy", "/repo/src/app/main.ts"],
    ["copy", "src/app/main.ts"],
    ["reveal", "/repo/src/app/main.ts"],
    ["openInEditor", "/repo/src/app/main.ts"],
    ["openWithDefault", "/repo/src/app/main.ts"],
    ["ignoreFiles", ["/src/app"]]
  ])
})

it("a root-level file has no folder submenu and .gitignore cannot ignore itself", () => {
  const target = file(".gitignore")
  const { entries } = harness({ file: target, files: [target] })
  assert.deepEqual(describe(entries).slice(0, 4), ["discard", "—", "ignore-file (disabled)", "—"])
  assert.equal(extname(".gitignore"), "")
})

it("several selected files: ignore selected, include / exclude, copy paths; at most five extension rules", () => {
  const files = [
    file("a.ts"),
    file("b.js"),
    file("c.css"),
    file("d.md"),
    file("e.json"),
    file("f.yml"),
    file("g.ts"),
    file(".gitignore")
  ]
  const { entries, calls } = harness({ file: files[0], files })
  assert.deepEqual(describe(entries), [
    "discard",
    "—",
    "ignore-selected",
    "ignore-extension:.ts",
    "ignore-extension:.js",
    "ignore-extension:.css",
    "ignore-extension:.md",
    "ignore-extension:.json",
    "—",
    "include-selected",
    "exclude-selected",
    "—",
    "copy-paths",
    "copy-relative-paths",
    "—",
    "reveal",
    "open-in-editor",
    "open-with-default"
  ])
  assert.equal(item(entries, "discard").label, 'changes.menu.discardSelected {"count":8}')
  assert.equal(item(entries, "ignore-selected").label, 'changes.menu.ignoreSelected {"count":8}')
  item(entries, "ignore-selected").action()
  item(entries, "exclude-selected").action()
  item(entries, "copy-relative-paths").action()
  assert.deepEqual(calls[0], ["ignoreFiles", ["a.ts", "b.js", "c.css", "d.md", "e.json", "f.yml", "g.ts"]])
  assert.deepEqual(calls.slice(1, 3), [
    ["includeChanged", "a.ts", false],
    ["includeChanged", "b.js", false]
  ])
  assert.deepEqual(calls.at(-1), ["copy", files.map(file => file.path).join("\n")])
})

it("a deleted file cannot be revealed or opened", () => {
  const target = file("gone.ts", "deleted")
  const { entries } = harness({ file: target, files: [target] })
  assert.equal(item(entries, "reveal").enabled, false)
  assert.equal(item(entries, "open-in-editor").enabled, false)
  assert.equal(item(entries, "open-with-default").enabled, false)
})

it("the editor label and platform file manager name follow Desktop", () => {
  const { entries } = harness({ externalEditorLabel: "Zed", platform: "windows" })
  assert.equal(item(entries, "open-in-editor").label, 'nativeMenu.openIn {"name":"Zed"}')
  assert.equal(item(entries, "reveal").label, "changes.menu.showInExplorer")
  assert.equal(fullPath(String.raw`C:\repo`, "src/app/main.ts", "windows"), String.raw`C:\repo\src\app\main.ts`)
  // Windows: RestrictedFileExtensions keep .sh / .exe / .cmd / .bat away from the default program
  const script = file("run.sh")
  const windows = harness({ file: script, files: [script], platform: "windows", repositoryPath: String.raw`C:\repo` })
  assert.equal(item(windows.entries, "open-with-default").enabled, false)
  item(windows.entries, "copy-path").action()
  assert.deepEqual(windows.calls, [["copy", String.raw`C:\repo\run.sh`]])
  const macos = harness({ file: script, files: [script] })
  assert.equal(item(macos.entries, "open-with-default").enabled, true)
})

it("during a rebase conflict only untracked files can be discarded; copy and open stay", () => {
  const tracked = file("src/app/main.ts")
  assert.deepEqual(describe(harness({ rebaseConflict: true }).entries), [
    "copy-path",
    "copy-relative-path",
    "—",
    "reveal",
    "open-in-editor",
    "open-with-default"
  ])
  const untracked = file("new.ts", "added", "untracked")
  assert.deepEqual(describe(harness({ rebaseConflict: true, file: untracked, files: [untracked, tracked] }).entries), [
    "discard",
    "—",
    "copy-path",
    "copy-relative-path",
    "—",
    "reveal",
    "open-in-editor",
    "open-with-default"
  ])
})
