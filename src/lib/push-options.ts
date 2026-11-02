// Desktop MIT implementation extracted unchanged from lib/git/push.ts.
import type { Branch } from "../models/branch"
import type { HookCallbackOptions } from "./git-execution"
export type PushOptions = {
  /**
   * Force-push the branch without losing changes in the remote that
   * haven't been fetched.
   *
   * See https://git-scm.com/docs/git-push#Documentation/git-push.txt---no-force-with-lease
   */
  readonly forceWithLease?: boolean

  /** A branch to push instead of the current branch */
  readonly branch?: Branch

  readonly noVerify?: boolean
} & HookCallbackOptions
