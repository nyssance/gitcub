// 自有回归：SSH 远端匹配非标准 HTTPS 端口的自建实例账号（Desktop 按 hostname 匹配）。
import { expect, test } from "bun:test"

import {
  accountHostFor,
  accountRemoteFor,
  instanceFromURL,
  remoteWithin,
  splitInstance
} from "../../src/lib/account-host"

test("SSH 远端匹配唯一一个同 hostname 的端口账号", () => {
  expect(accountHostFor("git.example", ["github.com", "git.example:8443"])).toBe("git.example:8443")
})

test("完全相同的账号主机优先", () => {
  expect(accountHostFor("git.example", ["git.example", "git.example:8443"])).toBe("git.example")
})

test("同一主机多个端口时不猜", () => {
  expect(accountHostFor("git.example", ["git.example:8443", "git.example:9443"])).toBe("git.example")
})

test("带端口的 HTTPS 远端保持原样", () => {
  expect(accountHostFor("git.example:8443", ["git.example:9443"])).toBe("git.example:8443")
})

test("IPv6 主机按 hostname 匹配", () => {
  expect(accountHostFor("[2001:db8::1]", ["[2001:db8::1]:8443"])).toBe("[2001:db8::1]:8443")
  expect(accountHostFor("[2001:db8::1]:8443", ["[2001:db8::1]:9443"])).toBe("[2001:db8::1]:8443")
})

test("hostname 大小写不敏感，不同主机不匹配", () => {
  expect(accountHostFor("Git.Example", ["git.example:8443"])).toBe("git.example:8443")
  expect(accountHostFor("other.example", ["git.example:8443"])).toBe("other.example")
})

// 自有回归：部署在子路径下的自建 GitLab，实例标识是 host[:port]/子路径（与 src-tauri/src/remote.rs 同一规则）。
const remote = (host: string, owner: string, name = "project") => ({ host, owner, name })

test("HTTPS 远端落在子路径实例下时 owner 去掉子路径", () => {
  const known = ["github.com", "git.example/gitlab"]
  expect(accountRemoteFor(remote("git.example", "gitlab/group/sub"), known)).toEqual(
    remote("git.example/gitlab", "group/sub")
  )
  expect(accountRemoteFor(remote("Git.Example", "GitLab/group"), known)).toEqual(remote("git.example/gitlab", "group"))
  expect(accountRemoteFor(remote("github.com", "nyssance", "gitcub"), known)).toEqual(
    remote("github.com", "nyssance", "gitcub")
  )
})

test("子路径按整段匹配，项目必须有命名空间", () => {
  const known = ["git.example/gitlab", "git.example/other"]
  expect(accountRemoteFor(remote("git.example", "gitlabx/group"), known)).toEqual(
    remote("git.example", "gitlabx/group")
  )
  expect(remoteWithin(remote("git.example", "gitlab"), "git.example/gitlab")).toBeNull()
})

test("子路径实例的端口必须一致", () => {
  const known = ["git.example:8443/gitlab"]
  expect(accountRemoteFor(remote("git.example:8443", "gitlab/group/sub"), known)).toEqual(
    remote("git.example:8443/gitlab", "group/sub")
  )
  expect(accountRemoteFor(remote("git.example:9443", "gitlab/group"), known)).toEqual(
    remote("git.example:9443", "gitlab/group")
  )
})

test("同主机多个实例取子路径最长的匹配", () => {
  const known = ["git.example", "git.example/gitlab", "git.example/gitlab/next"]
  expect(accountRemoteFor(remote("git.example", "gitlab/group"), known)).toEqual(remote("git.example/gitlab", "group"))
  expect(accountRemoteFor(remote("git.example", "gitlab/next/group"), known)).toEqual(
    remote("git.example/gitlab/next", "group")
  )
  expect(accountRemoteFor(remote("git.example", "group"), known)).toEqual(remote("git.example", "group"))
})

test("SSH 远端挂到唯一同 hostname 的子路径实例，有歧义时不猜", () => {
  expect(accountRemoteFor(remote("git.example", "group/sub"), ["git.example/gitlab"])).toEqual(
    remote("git.example/gitlab", "group/sub")
  )
  expect(accountHostFor("git.example", ["git.example:8443/gitlab"])).toBe("git.example:8443/gitlab")
  expect(accountHostFor("git.example", ["git.example/a", "git.example/b"])).toBe("git.example")
  expect(accountRemoteFor(remote("git.example", "group"), ["git.example", "git.example/gitlab"])).toEqual(
    remote("git.example", "group")
  )
})

test("设置里添加的实例地址规整为实例标识", () => {
  expect(instanceFromURL(new URL("https://Git.Example/gitlab/"))).toBe("git.example/gitlab")
  expect(instanceFromURL(new URL("https://git.example:8443/tools/gitlab"))).toBe("git.example:8443/tools/gitlab")
  expect(instanceFromURL(new URL("https://git.example:443/"))).toBe("git.example")
  expect(instanceFromURL(new URL("https://user@git.example/gitlab"))).toBeNull()
  expect(instanceFromURL(new URL("https://git.example/gitlab?x=1"))).toBeNull()
  expect(instanceFromURL(new URL("https://git.example/gitlab#x"))).toBeNull()
  expect(instanceFromURL(new URL("https://git.example//gitlab"))).toBeNull()
  expect(splitInstance("git.example:8443/gitlab/")).toEqual(["git.example:8443", "gitlab"])
})
