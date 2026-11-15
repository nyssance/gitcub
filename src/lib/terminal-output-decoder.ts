export interface TerminalChunk {
  readonly stream: "stdout" | "stderr"
  readonly bytes: readonly number[]
}
/** UTF-8 state belongs to each pipe, including replacement of incomplete tails. */
export class TerminalOutputDecoder {
  private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
  push({ stream, bytes }: TerminalChunk): string {
    return this.decoders[stream].decode(new Uint8Array(bytes), { stream: true })
  }
  finish(): string {
    return this.decoders.stdout.decode() + this.decoders.stderr.decode()
  }
}
