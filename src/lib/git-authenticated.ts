// Every credential acquired by the Desktop helper is leased until Rust reports
// process exit, including failed Git commands. The upstream lifecycle releases
// waiting API/SDK consumers in its finally block.

import { GitError } from "./git-error"
import { executeGit, type ExecutionOptions } from "./git-execution"
import { withTrampolineEnv } from "./trampoline/trampoline-environment"
export function git(args: string[], repo: string, name?: string, options?: ExecutionOptions) {
  return withTrampolineEnv(
    async environment => {
      try {
        return await executeGit(args, repo, name, { ...options, env: { ...environment, ...options?.env } })
      } catch (error) {
        if (error instanceof Error) throw error
        if (
          typeof error === "object" &&
          error !== null &&
          "stdout" in error &&
          "stderr" in error &&
          "exitCode" in error
        )
          throw new GitError(error as { stdout: string; stderr: string; exitCode: number }, args)
        throw new Error(String(error), { cause: error })
      }
    },
    repo,
    false,
    options?.env
  )
}
