// Desktop MIT port of lib/hooks/with-hooks-env.ts. The proxy server and the hook proxy itself live in Rust
// (src-tauri/src/hooks.rs); this side decides whether the operation needs them, loads the shell environment
// the hooks run with, and relays HookProgress / onHookFailure from the native channel.

import { Channel, invoke } from "@tauri-apps/api/core"
import memoizeOne from "memoize-one"

import type { HookCallbackOptions } from "../git-execution"
import { getCacheHooksEnv, getGitHookEnvShell, getHooksEnvEnabled, type SupportedHooksEnvShell } from "./config"
import { getShellEnv } from "./get-shell-env"

/** What the native proxy runs hooks with (hooks.rs HooksEnv) */
export type HooksEnv =
  | { env: Record<string, string | undefined> }
  | { failure: { kind: "notFound"; shellKind?: SupportedHooksEnvShell } | { kind: "error" } }

type HookEvent =
  | { kind: "progress"; id: number; hookName: string; status: "started" | "finished" | "failed" }
  | { kind: "failure"; id: number; hookName: string; terminalOutput: number[] }

const memoizedGetShellEnv = memoizeOne(async (shellKind: SupportedHooksEnvShell, cwd: string, _cacheKey: string) => {
  const shellEnvStartTime = Date.now()
  const shellEnv = await getShellEnv(cwd, shellKind)
  console.debug(`hooks: loaded shell environment in ${Date.now() - shellEnvStartTime}ms`)
  return shellEnv
})

/** null when the hooks environment is off or the repository has none of `interceptHooks` */
export async function getHooksEnv(path: string, interceptHooks: readonly string[]): Promise<HooksEnv | null> {
  if (!getHooksEnvEnabled()) {
    return null
  }
  const hooks = await invoke<string[]>("repo_hooks", { repo: path, filter: interceptHooks })
  if (hooks.length === 0) {
    return null
  }
  try {
    // We always cache environment per token (i.e. per operation, e.g commit, apply, etc)
    // but we can optionally cache it over multiple operations in the same repository if the user
    // has enabled that setting.
    const shellEnv = await memoizedGetShellEnv(
      getGitHookEnvShell(),
      path,
      getCacheHooksEnv() ? "global" : crypto.randomUUID()
    )
    return shellEnv.kind === "success"
      ? { env: shellEnv.env }
      : { failure: { kind: "notFound", shellKind: shellEnv.shellKind } }
  } catch (error) {
    console.error("hooks: failed to load shell environment", error)
    return { failure: { kind: "error" } }
  }
}

// Desktop lib/git/*.ts interceptHooks (https://git-scm.com/docs/githooks/2.46.1). The Rust commands intercept
// the same lists per git command; these decide whether the shell environment has to be loaded first.
export const commitInterceptHooks = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-auto-gc"]
export const amendInterceptHooks = [...commitInterceptHooks, "post-rewrite"]
export const pushInterceptHooks = ["pre-push"]
export const pullInterceptHooks = [
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-merge",
  "pre-rebase",
  "pre-commit",
  "post-rewrite"
]
/** merge.ts runs `git merge` and, for a squash, `git commit`; both lists together */
export const mergeInterceptHooks = [
  "pre-merge-commit",
  "post-merge",
  "commit-msg",
  "prepare-commit-msg",
  "post-commit",
  "pre-auto-gc"
]

/** The `hooks` and `events` arguments of a native command that runs git with interceptHooks */
export async function hookArgs(path: string, interceptHooks: readonly string[], options?: HookCallbackOptions) {
  return { hooks: await getHooksEnv(path, interceptHooks), events: hookEvents(options) }
}

/** The native side of onHookProgress / onHookFailure */
export function hookEvents(options?: HookCallbackOptions) {
  const channel = new Channel<HookEvent>()
  channel.onmessage = event => {
    if (event.kind === "progress") {
      const { id, hookName, status } = event
      options?.onHookProgress?.(
        status === "started"
          ? { hookName, status, abort: () => void invoke("abort_hook", { id }) }
          : { hookName, status }
      )
      return
    }
    const terminalOutput = new TextDecoder().decode(new Uint8Array(event.terminalOutput))
    const resolution = options?.onHookFailure?.(event.hookName, terminalOutput) ?? Promise.resolve("abort")
    void resolution
      .catch(() => "abort" as const)
      .then(result => invoke("resolve_hook_failure", { id: event.id, ignore: result === "ignore" }))
  }
  return channel
}
