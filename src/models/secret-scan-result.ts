// Desktop MIT implementation extracted unchanged from ui/secret-scanning/push-protection-error-dialog.tsx.
export interface ISecretLocation {
  /**The SHA of the commit where the secret was detected. */
  commitSha: string
  /** The file path where the secret is located. */
  path: string
  /** The line number in the file where the secret is found. */
  lineNumber: number
}

/** Represents secret detected by GitHub's Secret Scanning feature on push. */
export interface ISecretScanResult {
  /** The id used in the bypassURL to unique identify this secret */
  id: string
  /** The name of the secret - e.g "GitHub Access Token" */
  description: string
  /** The location of the secret, given as a commitSha, file path, and line number */
  locations: ReadonlyArray<ISecretLocation>
  /** The URL to use to get to GitHub.com's dialog for bypassing blocking the push of the secret  */
  bypassURL: string
  /** The user cannot bypass themselves, but can request a bypass */
  requiresApproval: boolean
}
