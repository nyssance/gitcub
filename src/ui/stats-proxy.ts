import { invoke } from "@tauri-apps/api/core"
export type Architecture = "x64" | "arm64" | "x64-emulated"
export const getAppArchitecture = () => invoke<Architecture>("app_architecture")
export const isInApplicationFolder = () => invoke<boolean>("is_in_application_folder")
export const getGUID = () => invoke<string>("get_stats_guid")
export const saveGUID = (guid: string) => invoke<void>("save_stats_guid", { guid })
