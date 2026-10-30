import type { StashEntry } from "@/models/app-state"
import type { IAheadBehind } from "@/models/branch"

/** 「没有本地改动」空白页的首要建议，照 Desktop `changes/no-changes.tsx` renderActions：
 *  有当前分支的 Desktop 贮藏就先建议看贮藏（renderViewStashAction），否则按 renderRemoteAction 的顺序
 *  挑远端动作：没有远端 → 发布仓库；分支没上游 → 发布分支；建议强推时不给建议；落后 → 拉取；
 *  领先或有待推标签 → 推送；GitHub 且没开着的 PR、也不在默认分支 → 创建 PR；否则没有。 */
export type RemoteSuggestion = "publish-repository" | "publish-branch" | "pull" | "push" | "create-pull-request"

export type PrimarySuggestion = "view-stash" | RemoteSuggestion

export interface NoChangesRepositoryState {
  /** 当前分支名；分离 HEAD / 未出生的分支是 null（Desktop TipState !== Valid） */
  branch: string | null
  remote: string | null
  /** 分支没有上游时是 null */
  aheadBehind: IAheadBehind | null
  tagsToPush: ReadonlyArray<string> | null
  /** 变基之后建议强推（ForcePushBranchState.Recommended） */
  isForcePush: boolean
  defaultBranch: string | null
  hasCurrentPullRequest: boolean
  /** 仓库挂在 GitHub / GitLab 上 */
  isHosted: boolean
  /** 当前分支的 Desktop 贮藏 */
  stashEntry: StashEntry | null
}

export function remoteSuggestion(state: NoChangesRepositoryState): RemoteSuggestion | null {
  const { branch, remote, aheadBehind, tagsToPush, isForcePush, defaultBranch, hasCurrentPullRequest, isHosted } = state
  if (branch === null) return null
  if (remote === null) return "publish-repository"
  if (aheadBehind === null) return "publish-branch"
  // do not render an action currently after the rebase has completed, as the default behaviour is
  // currently to pull in changes from the tracking branch which could lead to a more confusing history
  if (isForcePush) return null
  if (aheadBehind.behind > 0) return "pull"
  if (aheadBehind.ahead > 0 || (tagsToPush !== null && tagsToPush.length > 0)) return "push"
  const isDefaultBranch = defaultBranch !== null && branch === defaultBranch
  if (isHosted && !hasCurrentPullRequest && !isDefaultBranch) return "create-pull-request"
  return null
}

export function primarySuggestion(state: NoChangesRepositoryState): PrimarySuggestion | null {
  if (state.branch !== null && state.stashEntry !== null) return "view-stash"
  return remoteSuggestion(state)
}

/** Desktop createDesktopStashMessage：`!!GitHub_Desktop<branch>`；只有本客户端建的、挂在当前分支上的才算 */
export function desktopStashForBranch(stashes: ReadonlyArray<StashEntry>, branch: string | null): StashEntry | null {
  if (branch === null) return null
  return stashes.find(stash => stash.ours && stash.message.endsWith(`<${branch}>`)) ?? null
}
