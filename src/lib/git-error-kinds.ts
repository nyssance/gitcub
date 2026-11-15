/** Error names serialized by the native Git error parser. */
export const GitError = {
  RemoteAlreadyExists: "RemoteAlreadyExists",
  MergeConflicts: "MergeConflicts",
  HTTPSAuthenticationFailed: "HTTPSAuthenticationFailed",
  SSHAuthenticationFailed: "SSHAuthenticationFailed",
  SSHPermissionDenied: "SSHPermissionDenied"
} as const
