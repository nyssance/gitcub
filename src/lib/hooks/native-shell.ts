import { invoke } from "@tauri-apps/api/core"
export const getShellVariables = async () =>
  (await invoke<{ variables: Record<string, string | undefined> }>("shell_context")).variables
export const getGitInstallPath = async () =>
  (await invoke<{ gitInstallPath: string | null }>("shell_context")).gitInstallPath
export const which = (name: string, _options: { nothrow: true }) =>
  invoke<string | null>("shell_find_executable", { name })
export const getPrintenvzPath = () => invoke<string>("printenvz_path")
export const captureShell = (options: {
  shell: string
  args: readonly string[]
  cwd?: string
  windowsVerbatimArguments?: boolean
  argv0?: string
}) => invoke<{ stdout: string; stderr: string }>("shell_capture_environment", { options })
