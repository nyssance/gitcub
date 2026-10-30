// Desktop command dispatch and token validation; Node TCP is replaced by Rust.
import { Channel, invoke } from "@tauri-apps/api/core"

import type { TrampolineCommandHandler, TrampolineCommandIdentifier } from "./trampoline-command"
import { TrampolineCommandParser } from "./trampoline-command-parser"
import { isValidTrampolineToken } from "./trampoline-tokens"
export class TrampolineServer {
  private listeningPromise: Promise<number> | null = null
  private readonly commandHandlers = new Map<TrampolineCommandIdentifier, TrampolineCommandHandler>()
  registerCommandHandler(identifier: TrampolineCommandIdentifier, handler: TrampolineCommandHandler) {
    this.commandHandlers.set(identifier, handler)
  }
  getPort(): Promise<number> {
    if (this.listeningPromise) return this.listeningPromise
    const requests = new Channel<{ id: number; values: string[] }>()
    requests.onmessage = request => {
      void this.processCommand(request).catch(error => log.error("Trampoline transport error", error))
    }
    this.listeningPromise = invoke<number>("start_trampoline", { requests }).catch(error => {
      this.listeningPromise = null
      throw error
    })
    return this.listeningPromise
  }
  private async processCommand({ id, values }: { id: number; values: readonly string[] }) {
    let result: string | undefined
    try {
      const parser = new TrampolineCommandParser()
      for (const value of values) parser.processValue(value)
      const command = parser.toCommand()
      if (command) {
        if (!isValidTrampolineToken(command.trampolineToken)) throw new Error("Tried to use invalid trampoline token")
        const handler = this.commandHandlers.get(command.identifier)
        result = await handler?.(command)
      }
    } catch (error) {
      log.error("Error processing trampoline command", error)
    } finally {
      await invoke("respond_trampoline", { id, result: result ?? "" })
    }
  }
}
export const trampolineServer = new TrampolineServer()
