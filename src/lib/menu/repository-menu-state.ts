import type { AppState, Remote } from "@/models/app-state"
import type { RepoStatus } from "@/models/repo-status"

export interface NativeMenuContext {
  state: AppState | null
  status: RepoStatus
  busy: boolean
  remote: Remote | null
  stashesVisible: boolean
  filterVisible: boolean
  hasStashes: boolean
  platform: "github" | "gitlab"
}

/** Desktop menu-update.ts predicates, mapped to GitCub's repository state. */
export function repositoryMenuState(context: NativeMenuContext, defaultBranch?: string): Record<string, boolean> {
  const { state, status, busy, remote, hasStashes } = context
  const active = !!state?.selectedRepository && !busy
  const branch = active && !!status.branch
  const mutable = branch && !status.operation
  const hosted = active && !!remote
  const published = branch && status.hasUpstream
  const changed = active && status.changes.length > 0 && !status.operation
  return {
    repository: active,
    branch: active,
    "remove-repository": active,
    "open-in-shell": active,
    "open-working-directory": active,
    "show-repository-settings": active,
    "go-to-commit-message": active,
    "show-changes": active,
    "show-history": active,
    "show-branches-list": active,
    "show-worktrees-list": active,
    "open-external-editor": active,
    "open-with-external-editor": active,
    "toggle-changes-filter": active,
    "create-worktree": branch,
    "rename-branch": mutable && (!published || (!!defaultBranch && status.branch !== defaultBranch)),
    "delete-branch": mutable && !!defaultBranch && status.branch !== defaultBranch,
    "update-branch-with-contribution-target-branch": mutable && !!defaultBranch && status.branch !== defaultBranch,
    "merge-branch": mutable,
    "squash-and-merge-branch": mutable,
    "rebase-branch": mutable,
    "compare-on-github": hosted && published,
    "branch-on-github": hosted && published,
    "view-repository-on-github": hosted,
    "create-issue-in-repository-on-github": hosted,
    "create-pull-request": hosted && branch,
    "preview-pull-request": hosted && branch,
    push: branch && !!status.remote,
    pull: published,
    fetch: active && !!status.remote,
    "create-branch": mutable,
    "discard-all-changes": changed,
    "stash-all-changes": changed && branch && !status.changes.some(file => file.change === "conflicted"),
    "compare-to-branch": branch,
    "toggle-stashed-changes": active && hasStashes
  }
}
