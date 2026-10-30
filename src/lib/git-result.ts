export interface GitCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  progress?: (
    | { kind: "progress"; percent: number; details: { text: string } }
    | { kind: "context"; percent: number; text: string }
  )[]
}
