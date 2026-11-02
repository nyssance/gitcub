// 自有回归：按实例分别刷新远端仓库列表时，读取失败的实例保留上次成功显示的行（AGENTS.md：读取失败不能覆盖最后一次成功缓存）。
import { expect, test } from "bun:test"

import { keepLastSuccessful } from "../../src/lib/remote-repos"

const repo = (host: string, name: string) => ({
  host,
  owner: "me",
  name,
  description: "",
  language: "",
  stars: 0,
  private: false,
  fork: false,
  url: `https://${host}/me/${name}.git`
})

test("失败实例的旧行留在列表里，成功实例的新结果照常替换", () => {
  const previous = [repo("github.com", "a"), repo("git.example", "b"), repo("git.example", "c")]
  const seen = new Map([[repo("github.com", "d").url, repo("github.com", "d")]])
  const merged = [...keepLastSuccessful(seen, previous, "git.example").values()].map(it => `${it.host}/${it.name}`)
  expect(merged).toEqual(["github.com/d", "git.example/b", "git.example/c"])
})

test("只补失败实例的行，不把别的实例的旧行带回来", () => {
  const previous = [repo("github.com", "a"), repo("git.example", "b")]
  const merged = [...keepLastSuccessful(new Map(), previous, "git.example").values()].map(it => it.name)
  expect(merged).toEqual(["b"])
})

test("新结果已有的仓库不被旧行覆盖", () => {
  const stale = { ...repo("git.example", "b"), stars: 1 }
  const fresh = { ...repo("git.example", "b"), stars: 5 }
  const seen = new Map([[fresh.url, fresh]])
  expect([...keepLastSuccessful(seen, [stale], "git.example").values()]).toEqual([fresh])
})
