import { invoke } from "@tauri-apps/api/core"
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path })
