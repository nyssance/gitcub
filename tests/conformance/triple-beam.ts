// Winston's public global symbol identities, without importing a Node logger
// into the Tauri application.
export const MESSAGE = Symbol.for("message")
export const LEVEL = Symbol.for("level")
