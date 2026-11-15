import { invoke } from "@tauri-apps/api/core"
export const rm = (path: string) => invoke<void>("remove_file", { path })
export async function stat(path: string) {
  const value = await invoke<{ size: number; isDirectory: boolean; modifiedMillis: number }>("file_metadata", { path })
  return { size: value.size, isDirectory: () => value.isDirectory, mtime: new Date(value.modifiedMillis) }
}

export async function unlink(path: string) {
  try {
    await invoke<void>("unlink_file", { path })
  } catch (failure) {
    if (failure instanceof Error) throw failure
    if (typeof failure === "object" && failure !== null && "message" in failure)
      throw Object.assign(new Error(String(failure.message), { cause: failure }), failure)
    throw new Error(String(failure), { cause: failure })
  }
}

export async function readdir(path: string): Promise<string[]> {
  try {
    return await invoke<string[]>("read_directory", { path })
  } catch (failure) {
    if (failure instanceof Error) throw failure
    if (typeof failure === "object" && failure !== null && "message" in failure)
      throw Object.assign(new Error(String(failure.message), { cause: failure }), failure)
    throw new Error(String(failure), { cause: failure })
  }
}
