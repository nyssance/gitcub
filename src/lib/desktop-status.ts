import type { FileChange } from "@/models/repo-status"
import {
  type AppFileStatus,
  AppFileStatusKind,
  GitStatusEntry,
  type UnmergedEntry,
  UnmergedEntrySummary
} from "@/upstream/models/status"

/** Rust's index/worktree state mapped to the Desktop model used by patch generation. */
export function appStatus(file: FileChange): AppFileStatus {
  const submoduleStatus = file.submodule
    ? {
        commitChanged: file.submodule.commitChanged,
        modifiedChanges: file.submodule.modified,
        untrackedChanges: file.submodule.untracked
      }
    : undefined
  if (file.change === "conflicted" && file.conflict) {
    const c = file.conflict
    const details =
      c.hasOurs && c.hasTheirs
        ? c.hasBase
          ? ({
              action: UnmergedEntrySummary.BothModified,
              us: GitStatusEntry.UpdatedButUnmerged,
              them: GitStatusEntry.UpdatedButUnmerged
            } as const)
          : ({ action: UnmergedEntrySummary.BothAdded, us: GitStatusEntry.Added, them: GitStatusEntry.Added } as const)
        : c.hasOurs
          ? c.hasBase
            ? ({
                action: UnmergedEntrySummary.DeletedByThem,
                us: GitStatusEntry.UpdatedButUnmerged,
                them: GitStatusEntry.Deleted
              } as const)
            : ({
                action: UnmergedEntrySummary.AddedByUs,
                us: GitStatusEntry.Added,
                them: GitStatusEntry.UpdatedButUnmerged
              } as const)
          : c.hasTheirs
            ? c.hasBase
              ? ({
                  action: UnmergedEntrySummary.DeletedByUs,
                  us: GitStatusEntry.Deleted,
                  them: GitStatusEntry.UpdatedButUnmerged
                } as const)
              : ({
                  action: UnmergedEntrySummary.AddedByThem,
                  us: GitStatusEntry.UpdatedButUnmerged,
                  them: GitStatusEntry.Added
                } as const)
            : ({
                action: UnmergedEntrySummary.BothDeleted,
                us: GitStatusEntry.Deleted,
                them: GitStatusEntry.Deleted
              } as const)
    const entry: UnmergedEntry = { kind: "conflicted", ...details, submoduleStatus }
    if (
      !c.binary &&
      (entry.action === UnmergedEntrySummary.BothModified || entry.action === UnmergedEntrySummary.BothAdded)
    ) {
      return { kind: AppFileStatusKind.Conflicted, entry, conflictMarkerCount: c.markers }
    }
    return { kind: AppFileStatusKind.Conflicted, entry }
  }
  if (file.kind === "untracked") return { kind: AppFileStatusKind.Untracked, submoduleStatus }
  if (file.change === "added") return { kind: AppFileStatusKind.New, submoduleStatus }
  if (file.change === "deleted") return { kind: AppFileStatusKind.Deleted, submoduleStatus }
  if ((file.change === "renamed" || file.change === "copied") && file.oldPath !== null) {
    return {
      kind: file.change === "renamed" ? AppFileStatusKind.Renamed : AppFileStatusKind.Copied,
      oldPath: file.oldPath,
      renameIncludesModifications: file.kind === "both",
      submoduleStatus
    }
  }
  return { kind: AppFileStatusKind.Modified, submoduleStatus }
}
