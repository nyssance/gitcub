import { ipcRenderer } from "../lib/platform-ipc"
export const sendDialogDidOpen = () => ipcRenderer.send("dialog-did-open")

import type { OpenDialogOptions, SaveDialogOptions } from "./native-dialog-options"

export type { OpenDialogOptions, SaveDialogOptions } from "./native-dialog-options"
export const showOpenDialog = (options: OpenDialogOptions) =>
  ipcRenderer.invoke("show-open-dialog", options) as Promise<string | null>
export const showSaveDialog = (options: SaveDialogOptions) =>
  ipcRenderer.invoke("show-save-dialog", options) as Promise<string | null>
