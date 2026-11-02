import { invoke } from "@tauri-apps/api/core"

import type { IAheadBehind } from "../models/branch"
export const revSymmetricDifference = (from: string, to: string) => `${from}...${to}`
export async function getAheadBehind(repository: { path: string }, range: string): Promise<IAheadBehind | null> {
  const counts = await invoke<[number, number] | null>("ahead_behind_range", { repo: repository.path, range })
  return counts === null ? null : { ahead: counts[0], behind: counts[1] }
}
