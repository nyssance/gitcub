import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { createInterface } from "node:readline"

import { executable } from "./bridge"
let trampoline: ChildProcessWithoutNullStreams | undefined
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
let statsDirectory: string | undefined
// 命名 JSON 存储（Rust named_store）的内存替身；真实落盘只保留 JSON 可表示的值，测试里库只在 open() 时读回。
const namedStores = new Map<string, Map<string, unknown>>()
function namedStore(args: Record<string, unknown>) {
  const id = `${args.scope}:${args.store}`
  let store = namedStores.get(id)
  if (!store) namedStores.set(id, (store = new Map()))
  return store
}
export function isTauri() {
  return false
}
export class Channel<T> {
  onmessage: (message: T) => void = () => {}
}
import { call, streamCall } from "./bridge.ts"
export async function invoke(command: string, args: Record<string, unknown>) {
  switch (command) {
    case "trampoline_helpers":
      return call("trampoline/build-paths", {})
    case "git_environment":
      return call("trampoline/environment", {})
    case "start_trampoline": {
      const child = spawn(executable, ["--trampoline-relay"])
      trampoline = child
      const requests = args.requests as Channel<unknown>
      const ready = new Promise<number>((resolve, reject) => {
        createInterface({ input: child.stdout }).on("line", line => {
          const frame = JSON.parse(line)
          if (frame.port) resolve(frame.port)
          else requests.onmessage(frame)
        })
        child.once("error", reject)
        child.once("exit", code => reject(new Error(`Trampoline relay exited: ${code}`)))
      })
      child.unref()
      // Bun's child streams have no unref; the relay must not keep Node's loop alive either.
      for (const stream of [child.stdin, child.stdout, child.stderr])
        (stream as unknown as { unref?: () => void }).unref?.()
      return ready
    }
    case "respond_trampoline": {
      if (!trampoline) throw new Error("Trampoline relay not started")
      trampoline.stdin.write(`${JSON.stringify(args)}\n`)
      return
    }
    case "shell_context":
      return call("shell/context", {})
    case "shell_find_executable":
      return call("shell/which", args)
    case "printenvz_path":
      return call("shell/printenvz", {})
    case "shell_capture_environment": {
      const result = call("shell/capture", args)
      if (result.failure) throw Object.assign(new Error(result.failure.message), result.failure)
      return result.value
    }
    case "submit_notification":
      return call("notifications/show", args)
    case "app_architecture":
      return call("stats/architecture", {})
    case "is_in_application_folder":
      return call("stats/in-applications", {})
    case "get_stats_guid":
      return call("stats/guid", { directory: (statsDirectory ??= mkdtempSync(join(tmpdir(), "gitcub-stats-"))) })
    case "read_directory": {
      const result = call("file/read-directory", args)
      if (result.failure) throw result.failure
      return result.value
    }
    case "working_directory":
      return process.cwd()
    case "execute_process": {
      const result = call("process/execute", args)
      if (result.failure) throw result.failure
      return result.value
    }

    case "worktrees":
      return call("worktree/list", args)
    case "branch_checkouts":
      return call("reflog/checkouts", args)
    case "delete_branch":
      return call("branch/delete", args)
    case "repository_type":
      return call("repository/type", { repo: args.path })
    case "branch_details":
      return call("branch/list", args)
    case "checkout":
      return call("checkout", args)
    case "repository_tip":
      return call("branch/tip", args)
    case "stash_push":
      return call("stash/push", args)
    case "cherry_pick":
      return call("cherry-pick/stream", args)
    case "repo_status":
      return call("status", args)
    case "rebase_internal_state":
      return call("rebase/state", args)
    case "remote_push_url":
      return call("remote/push-url", args)
    case "remotes":
      return call("remote/list", args)
    case "parse_remote":
      return call("remote/parse", args)
    case "set_remote_url":
      return call("remote/set-url", args)
    case "add_remote":
      return call("remote/add", args)
    case "remove_remote":
      return call("remote/remove", args)
    case "update_remote_head":
      return call("remote/update-head", args)
    case "get_remote_head":
      return call("remote/head", args)
    case "global_config_value":
      return call("config/get", { ...args, local: args.onlyLocal ?? false })
    case "set_global_config_value":
      return call("config/set", args)
    case "create_branch":
      return call("branch/create", { ...args, start: args.startPoint })
    case "recent_branches":
      return call("reflog/recent", args)
    case "create_tag":
      return call("tags/create", args)
    case "delete_tag":
      return call("tags/delete", args)
    case "tag_targets":
      return call("tags/list", args)
    case "list_submodules":
      return call("submodules/list", args)
    case "reset_submodules":
      return call("submodules/reset", args)
    case "format_commit_message":
      return call("commit/format", args)
    case "stashes":
      return call("stash/list", args)
    case "fetch_refspec":
      return call("remote/fetch-refspec", args)
    case "file_metadata":
      return call("file/metadata", args)
    case "unlink_file": {
      const result = call("file/unlink", args)
      if (result.failure) throw result.failure
      return result.value
    }
    case "remove_file":
      return call("file/remove", args)
    case "path_exists":
      return call("file/exists", args)
    case "git_metadata_exists":
      return call("git/metadata-exists", args)

    case "ahead_behind_range":
      return call("revision/ahead-behind", args)
    case "get_boolean_config_value": {
      const value = call("config/get", { ...args, boolean: true })
      return value === null ? undefined : value === "true"
    }
    case "commit_details":
      return call("history/details", args)
    case "file_size":
      return call("file/size", args)
    case "read_conflict_text":
      return call("file/conflict-text", args)
    case "resolve_within":
      return call("file/resolve", { ...args, repo: args.root })
    case "merge_base":
      return call("merge/base", args)

    case "get_config_value":
      return call("config/get", { ...args, local: args.onlyLocal ?? false })
    case "git_execute": {
      const { output, ...request } = args
      return streamCall(request, output as Channel<import("../../src/lib/terminal-output-decoder").TerminalChunk>)
    }
    case "fetch_output":
      return call("remote/fetch-output", args)
    case "pull_output":
      return call("remote/pull-output", args)
    case "clone_repo_output":
      return call("clone", args)
    case "image_diff":
      return call("image/diff", args)
    case "working_image":
      return call("image/working", args)
    case "blob_image":
      return call("image/blob", args)
    case "submodule_info":
      return call("submodule/info", args)
    case "merge_base_diff":
      return call("diff/merge-base", args)
    case "push_with_tags":
      return call("tags/push", args)
    case "working_directory_diff":
      return call("diff", args)
    case "resolution_diff":
      return call("diff/resolution", args)
    case "discard_lines":
      return call("diff/discard", args)
    case "apply_selection":
      return call("selection", args)
    case "store_entries":
      return Object.fromEntries(namedStore(args))
    case "store_set":
      namedStore(args).set(args.key as string, structuredClone(args.value))
      return
    case "store_delete":
      namedStore(args).delete(args.key as string)
      return
    case "store_clear":
      namedStore(args).clear()
      return
    case "store_reload":
      return
    // GitLens operations/graph integration suites (gitlens-integration.ts operations block).
    case "commit":
      return call("commit/create", args)
    case "amend_commit":
      return call("commit/amend", args)
    case "merge_branch":
      return call("merge/branch", args)
    case "graph":
      return call("graph", args)
    default:
      throw new Error(`Unsupported IPC in conformance: ${command}`)
  }
}
