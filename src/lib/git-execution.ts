import type { Buffer } from "node:buffer"

import { Channel, invoke } from "@tauri-apps/api/core"

import type { HookProgress } from "../models/hook-progress"
import type { GitCommandResult } from "./git-result"
import { pushTerminalChunk } from "./terminal-chunks"
import { type TerminalChunk, TerminalOutputDecoder } from "./terminal-output-decoder"

export type TerminalOutput = string | string[] | Buffer
export type TerminalOutputListener = (callback: (chunk: TerminalOutput) => void) => { unsubscribe: () => unknown }
export type TerminalOutputCallback = (subscribe: TerminalOutputListener) => void
export type HookCallbackOptions = {
  onHookProgress?: (progress: HookProgress) => void
  onHookFailure?: (name: string, output: TerminalOutput) => Promise<"abort" | "ignore">
  onTerminalOutputAvailable?: TerminalOutputCallback
}
export interface ExecutionOptions extends HookCallbackOptions {
  interceptHooks?: readonly string[]
  env?: Record<string, string>
  stdin?: string
  successExitCodes?: Set<number>
  expectedErrors?: Set<string>
  onTerminalOutputAvailable?: TerminalOutputCallback
}
export interface ExecutionResult extends GitCommandResult {
  path: string
  gitError: string | null
  gitErrorDescription: string | null
}
/** Native execution with a bounded, replayable terminal stream. */
export async function executeGit(args: string[], repo: string, _name?: string, options?: ExecutionOptions) {
  if (options?.onHookProgress || options?.onHookFailure)
    throw new Error("Interactive hook callbacks require the native hook channel")
  const chunks: string[] = []
  const subscribers = new Set<(chunk: TerminalOutput) => void>()
  let started = false
  const output = new Channel<TerminalChunk>()
  const decoder = new TerminalOutputDecoder()
  const emit = (chunk: string) => {
    if (chunk.length === 0) return
    if (!started) {
      options?.onTerminalOutputAvailable?.(callback => {
        subscribers.add(callback)
        chunks.forEach(value => {
          callback(value)
        })
        return { unsubscribe: () => subscribers.delete(callback) }
      })
      started = true
    }
    pushTerminalChunk(chunks, 256 * 1024, chunk)
    subscribers.forEach(callback => {
      callback(chunk)
    })
  }
  output.onmessage = chunk => emit(decoder.push(chunk))
  try {
    return await invoke<ExecutionResult>("git_execute", {
      repo,
      args,
      env: options?.env ?? {},
      stdin: options?.stdin ?? null,
      successExitCodes: [...(options?.successExitCodes ?? [0])],
      expectedErrors: [...(options?.expectedErrors ?? [])],
      output
    })
  } finally {
    emit(decoder.finish())
  }
}
