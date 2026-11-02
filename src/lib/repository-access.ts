// Desktop MIT implementation extracted unchanged from lib/git/rev-parse.ts.
import { invoke } from "@tauri-apps/api/core"
export type RepositoryType =
  | { kind: "bare" }
  | { kind: "regular"; topLevelWorkingDirectory: string; gitDir: string }
  | { kind: "missing" }
  | { kind: "unsafe"; path: string }

export const getRepositoryType = (path: string) => invoke<RepositoryType>("repository_type", { path })
export const addSafeDirectory = (path: string) => invoke<void>("add_safe_directory", { path })
