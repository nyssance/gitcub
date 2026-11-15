// 自有回归：错误对话框移植（2026-11-01）。dugite 3.3.2 的错误识别表与 Desktop lib/git/core.ts getDescriptionForError
// 在这里按 TS 重做；后端命令失败只回文本，toPresentableError 对它重做 Desktop git() 的识别。
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { useDialogsStore } from "../../src/features/dialogs/store"
import { DugiteError, GitErrorRegexes, parseError } from "../../src/lib/dugite-errors"
import { ErrorWithMetadata } from "../../src/lib/error-with-metadata"
import { GitError } from "../../src/lib/git-error"
import { getDescriptionForError, isAuthFailureError } from "../../src/lib/git-error-description"
import { toPresentableError } from "../../src/lib/presentable-error"
import { Repository } from "../../src/models/repository"
import { RetryActionType } from "../../src/models/retry-actions"

test("识别表覆盖每个错误种类，每个种类都有确定的说明（文本或 null）", () => {
  const kinds = new Set(Object.values(GitErrorRegexes))
  expect([...kinds].toSorted()).toEqual(Object.values(DugiteError).toSorted())
  for (const kind of Object.values(DugiteError)) expect(getDescriptionForError(kind, "")).not.toBeUndefined()
})

test("英文说明与 Desktop core.ts getDescriptionForError 逐字一致", () => {
  const core = readFileSync(
    join(process.cwd(), "tests/conformance/upstream/desktop/production/lib/git/core.ts"),
    "utf8"
  )
  const body = core.slice(core.indexOf("export function getDescriptionForError"))
  // 「case DugiteError.X: … return '…'」：一个 return 前可能堆着几个 case
  const pattern = /((?:\s*case DugiteError\.\w+:)+)\s*return (['`"])(.*?)\2\n/g
  let checked = 0
  for (const [, cases, , text] of body.matchAll(pattern)) {
    for (const [, kind] of cases!.matchAll(/case DugiteError\.(\w+):/g)) {
      const expected = text!.replaceAll(String.raw`\'`, "'").replace("GitHub Desktop", "GitCub")
      expect(getDescriptionForError(kind as DugiteError, "")).toBe(expected)
      checked++
    }
  }
  expect(checked).toBeGreaterThan(40)
})

test("按 Desktop 的顺序识别 git 输出", () => {
  expect(
    parseError(
      "To github.com/o/r.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com/o/r.git'"
    )
  ).toBe(DugiteError.PushNotFastForward)
  expect(parseError("fatal: Authentication failed for 'https://github.com/o/r.git/'")).toBe(
    DugiteError.HTTPSAuthenticationFailed
  )
  expect(parseError("fatal: bad numeric config value 'x' for 'core.bigFileThreshold'")).toBe(DugiteError.BadConfigValue)
  expect(getDescriptionForError(DugiteError.BadConfigValue, "fatal: bad numeric config value 'x' for 'core.k'")).toBe(
    "Unsupported value 'x' for git config key 'core.k'"
  )
  expect(isAuthFailureError(DugiteError.SSHPermissionDenied)).toBe(true)
  expect(parseError("nothing here")).toBeNull()
})

test("后端回来的文本：认得出种类给说明，git 原始输出留原文，本应用自己的提示是普通错误", () => {
  const known = toPresentableError("fatal: Authentication failed for 'https://example.com/r.git/'")
  expect(known).toBeInstanceOf(GitError)
  expect((known as GitError).isRawMessage).toBe(false)
  expect(known.message.startsWith("Authentication failed. Some common reasons include:")).toBe(true)

  const overwritten = toPresentableError(
    "error: Your local changes to the following files would be overwritten by merge:\n\ta\nPlease commit your changes or stash them before you merge.\nAborting"
  )
  expect((overwritten as GitError).result.gitError).toBe(DugiteError.MergeWithLocalChanges)
  // Desktop 对这种没有说明，显示原始输出
  expect((overwritten as GitError).isRawMessage).toBe(true)

  const raw = toPresentableError(new Error("fatal: something unusual"))
  expect(raw).toBeInstanceOf(GitError)
  expect((raw as GitError).isRawMessage).toBe(true)

  const plain = toPresentableError("git 以退出码 1 结束")
  expect(plain).not.toBeInstanceOf(GitError)
  expect(plain.message).toBe("git 以退出码 1 结束")

  const parsed = new GitError({
    exitCode: 128,
    stdout: "",
    stderr: "fatal: Not a git repository (or any of the parent directories): .git"
  })
  expect(toPresentableError(parsed).message).toBe("This is not a git repository.")
})

// Desktop localChangesOverwrittenHandler：本地更改会被覆盖、带着仓库与重试动作的错误改弹「贮藏更改并继续」，其余照常进错误对话框
test("本地更改会被覆盖的错误转给贮藏并继续对话框，列出会被覆盖的文件", () => {
  useDialogsStore.setState({ errors: [], localChangesOverwritten: null })
  const repository = new Repository("/r", -1, null, false)
  const overwritten = toPresentableError(
    "error: Your local changes to the following files would be overwritten by merge:\n\ta\n\tdir/b\nPlease commit your changes or stash them before you merge.\nAborting"
  )
  const retryAction = { type: RetryActionType.Pull, repository } as const
  useDialogsStore.getState().postError(new ErrorWithMetadata(overwritten, { repository, retryAction }))
  expect(useDialogsStore.getState().localChangesOverwritten).toEqual({ retryAction, files: ["a", "dir/b"] })
  expect(useDialogsStore.getState().errors).toEqual([])

  // 没有重试动作就没法「继续」，仍是普通错误
  useDialogsStore.getState().postError(new ErrorWithMetadata(overwritten, { repository }))
  expect(useDialogsStore.getState().errors).toHaveLength(1)
  // 别的种类不归它管
  const other = new ErrorWithMetadata(toPresentableError("fatal: refusing to merge unrelated histories"), {
    repository,
    retryAction
  })
  useDialogsStore.getState().postError(other)
  expect(useDialogsStore.getState().errors.at(-1)).toBe(other)
})
