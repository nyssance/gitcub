// Native path queries only; filesystem behavior remains in the Rust transport.
import { homedir } from "node:os"
import { join } from "node:path"
export const resourceDir = async () => join(process.cwd(), "src-tauri/resources")
export const homeDir = async () => homedir()
export const documentDir = async () => join(homedir(), "Documents")
