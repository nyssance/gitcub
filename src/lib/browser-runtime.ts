// Browserify dependencies expect these globals before their modules execute.
// Keep the native Node globals intact when this module runs in conformance tests.
import { Buffer } from "node:buffer"
import process from "node:process"

globalThis.process ??= process
globalThis.Buffer ??= Buffer
