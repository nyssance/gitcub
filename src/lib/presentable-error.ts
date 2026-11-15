import { parseError } from "./dugite-errors"
import { ErrorWithMetadata } from "./error-with-metadata"
import { GitError } from "./git-error"
import { getDescriptionForError } from "./git-error-description"

/** git 自己的诊断行（fatal:、error:、hint:……）或冲突提示：这样的文本是 git 的原始输出 */
const gitOutput = /^(?:fatal|error|hint|remote|warning): |^CONFLICT \(/m

/**
 * Desktop lib/git/core.ts git() 在命令失败时按 stderr、再按 stdout 识别错误种类并配上说明，抛 GitError；
 * 识别不出种类时 GitError 的文字就是原始输出（isRawMessage，错误对话框用终端显示）。
 *
 * 后端命令失败只回一段文本，这里对它重做同一步。认不出种类、看起来也不是 git 输出的（本应用自己的提示）当普通错误。
 */
export function toPresentableError(cause: unknown): Error {
  if (cause instanceof ErrorWithMetadata) return cause
  if (cause instanceof GitError) {
    if (cause.result.gitError) return cause
    const gitError = parseError(cause.result.stderr) ?? parseError(cause.result.stdout)
    if (gitError === null) return cause
    const gitErrorDescription = getDescriptionForError(gitError, cause.result.stderr)
    return new GitError({ ...cause.result, gitError, gitErrorDescription }, cause.args)
  }
  const text = cause instanceof Error ? cause.message : String(cause)
  const gitError = parseError(text)
  if (gitError === null && !gitOutput.test(text)) return cause instanceof Error ? cause : new Error(text)
  const gitErrorDescription = gitError === null ? null : getDescriptionForError(gitError, text)
  return new GitError({ exitCode: 1, stdout: "", stderr: text, gitError, gitErrorDescription })
}
