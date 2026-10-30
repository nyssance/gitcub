import { invoke } from "@tauri-apps/api/core"

import type { IAppShell } from "./app-shell-contract"
import { showFolderContents } from "./show-folder-contents"

export type { IAppShell } from "./app-shell-contract"

import { openPath, openUrl, revealItemsInDir } from "@tauri-apps/plugin-opener"
export const shell: IAppShell = {
  moveItemToTrash: path => invoke<void>("trash_path", { path }),
  beep: () => {
    void invoke("desktop_beep").catch(console.error)
  },
  showItemInFolder: path => {
    void revealItemsInDir(path).catch(console.error)
  },
  showFolderContents: path => {
    void showFolderContents(path).catch(console.error)
  },
  openPath: async path => {
    try {
      await openPath(path)
      return ""
    } catch (error) {
      return String(error)
    }
  },
  openExternal: async (url: string): Promise<boolean> => {
    await openUrl(url)
    return true
  }
}
