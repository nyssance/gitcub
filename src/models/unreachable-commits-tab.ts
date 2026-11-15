// Desktop MIT implementation extracted unchanged from ui/history/unreachable-commits-dialog.tsx.
export const UnreachableCommitsTab = {
  Unreachable: 0,
  Reachable: 1
} as const
export type UnreachableCommitsTab = (typeof UnreachableCommitsTab)[keyof typeof UnreachableCommitsTab]
