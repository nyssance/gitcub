// Desktop MIT port; platform imports adapted to Tauri.

import { documentDir as getDocumentsPath } from "@tauri-apps/api/path"

import * as Path from "../platform-path"

const localStorageKey = "last-clone-location"

/** The path to the default directory. */
export async function getDefaultDir(): Promise<string> {
  return localStorage.getItem(localStorageKey) || Path.join(await getDocumentsPath(), "GitHub")
}

export function setDefaultDir(path: string) {
  localStorage.setItem(localStorageKey, path)
}
