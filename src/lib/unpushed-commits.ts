import type { RepoStatus } from "@/models/repo-status"

/** 历史列表里哪些提交还没推到远端，对应 Desktop `commit-list.tsx` renderCommit 的
 *  `showUnpushedIndicator = isLocal && !isLocalRepository`。
 *
 *  Desktop 的 `localCommitSHAs`（git-store.ts loadLocalCommits）在分支有上游时是 `upstream..branch`；
 *  本项目不另起 git 进程，用状态里现成的 ahead 数：HEAD 历史按 `--date-order` 从 HEAD 往回排，
 *  前 `ahead` 条就是 `upstream..HEAD`（app.tsx 的「已推送」判断用同一个假设）。
 *  没有远端（Desktop 的 isLocalRepository）不标；没有上游时 Desktop 用 `HEAD --not --remotes`
 *  标出不在任何远端上的提交——这一组由 app.tsx 每次仓库刷新取一次（`ipc.localCommits`，
 *  进程内 gix），按 SHA 传进来。 */
export type PushStatus = Pick<RepoStatus, "remote" | "hasUpstream" | "ahead">

/** 没有上游时的 Desktop `localCommitSHAs`：`HEAD --not --remotes` 的结果。
 *  `done` 为 false 表示还有没取完的页（Desktop 的 loadLocalCommits 也按 CommitBatchSize 翻页） */
export interface LocalCommits {
  shas: ReadonlySet<string>
  done: boolean
}

export function isUnpushedCommit(
  sha: string,
  headIndex: number | undefined,
  status: PushStatus | null | undefined,
  localCommits?: LocalCommits | null
): boolean {
  if (status?.remote == null) return false
  if (!status.hasUpstream) return localCommits?.shas.has(sha) ?? false
  return headIndex !== undefined && headIndex < status.ahead
}
