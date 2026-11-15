// Desktop MIT implementation extracted unchanged from ui/main-process-proxy.ts.
import { ipcRenderer } from "../lib/platform-ipc"

const writeClipboardTextProxy = (text: string) => ipcRenderer.invoke("write-clipboard-text", text)
export const sendDialogDidOpen = () => ipcRenderer.send("dialog-did-open")
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await writeClipboardTextProxy(text)
    return true
  } catch (error) {
    log.error("Failed to write text to clipboard", error)
    return false
  }
}
