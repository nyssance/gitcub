import { invoke } from "@tauri-apps/api/core"
export const stat = async (path: string) => ({ size: await invoke<number>("file_size", { path }) })
export const readFile = (path: string, _encoding: "utf8") => invoke<string>("read_conflict_text", { path })
export const resolveWithin = (root: string, ...segments: string[]) =>
  invoke<string | null>("resolve_within", { root, segments })
export const getMergeBase = (repository: { path: string }, first: string, second: string) =>
  invoke<string | null>("merge_base", { repo: repository.path, first, second })
