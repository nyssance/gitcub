// Desktop MIT implementation extracted unchanged from lib/git/core.ts.
export type HookProgress = {
  readonly hookName: string
} & (
  | {
      readonly status: "started"
      readonly abort: () => void
    }
  | {
      readonly status: "finished" | "failed"
    }
)
