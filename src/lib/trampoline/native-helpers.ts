import { invoke } from "@tauri-apps/api/core"
export interface TrampolineHelpers {
  askpass: string
  credentialHelper: string
  sshWrapper: string
}
let helpers: Promise<TrampolineHelpers> | undefined
export const getTrampolineHelpers = () => (helpers ??= invoke<TrampolineHelpers>("trampoline_helpers"))
export const getDesktopAskpassTrampolinePath = async () => (await getTrampolineHelpers()).askpass
export const getSSHWrapperPath = async () => (await getTrampolineHelpers()).sshWrapper
export const getGitEnvironment = () =>
  invoke<{ path: string; configParameters: string; platform: string; arch: string }>("git_environment")
