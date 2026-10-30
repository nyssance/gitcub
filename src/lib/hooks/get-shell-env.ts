// Desktop MIT port. Native spawn is supplied by Rust; selection, quoting and
// marker parsing retain the upstream contract (including shell startup output).

import type { SupportedHooksEnvShell } from "./config"
import { getShell } from "./get-shell"
import { captureShell, getPrintenvzPath } from "./native-shell"
export type ShellEnvResult =
  { kind: "success"; env: Record<string, string | undefined> } | { kind: "failure"; shellKind?: SupportedHooksEnvShell }
export async function getShellEnv(
  cwd?: string,
  shellKind?: SupportedHooksEnvShell,
  printenvzPath?: string
): Promise<ShellEnvResult> {
  printenvzPath ??= await getPrintenvzPath()
  const shellInfo = await getShell(shellKind)
  if (!shellInfo) return { kind: "failure", shellKind }
  const { shell, args, quoteCommand, windowsVerbatimArguments, argv0 } = shellInfo
  const { stdout } = await captureShell({
    shell,
    args: [...args, quoteCommand(printenvzPath)],
    cwd,
    windowsVerbatimArguments,
    argv0
  })
  const startRe = /--printenvz--begin\r?\n/
  const endRe = /\r?\n--printenvz--end\r?\n/g
  const startMatch = stdout.match(startRe)
  if (startMatch?.index === undefined) throw new Error("could not find start marker in shell output")
  const lastEndMatch = [...stdout.matchAll(endRe)].at(-1)
  if (!lastEndMatch) throw new Error("could not find end marker in shell output")
  const matches = stdout
    .slice(startMatch.index + startMatch[0].length, lastEndMatch.index)
    .matchAll(/([^=]+)=([^\0]*)\0/g)
  return { kind: "success", env: Object.fromEntries(Array.from(matches, m => [m[1], m[2]])) }
}
