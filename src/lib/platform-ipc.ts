import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { open, save } from "@tauri-apps/plugin-dialog"

import type { OpenDialogOptions, SaveDialogOptions } from "../ui/native-dialog-options"
import type { RequestChannels, RequestResponseChannels } from "./ipc-shared"
import * as notifications from "./notifications/native-module"

type ChannelHandler<K extends keyof RequestChannels> = (event: unknown, ...args: Parameters<RequestChannels[K]>) => void
const listeners = new Map<string, Map<unknown, Promise<() => void>>>()

import { invoke } from "@tauri-apps/api/core"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"

/** Desktop channel names at the native boundary; domain behavior stays upstream. */
const transport = {
  on<K extends keyof RequestChannels>(channel: K, callback: ChannelHandler<K>) {
    let handlers = listeners.get(channel)
    if (!handlers) {
      handlers = new Map()
      listeners.set(channel, handlers)
    }
    if (handlers.has(callback)) return
    handlers.set(
      callback,
      listen<unknown>(channel === "notification-event" ? "desktop-notification-event" : channel, ({ payload }) => {
        let args: unknown[]
        if (channel === "notification-event") {
          const notification = payload as { event: string; id: string; userInfo: unknown }
          args = [notification.event, notification.id, notification.userInfo]
        } else args = Array.isArray(payload) ? payload : payload === undefined ? [] : [payload]
        callback({}, ...(args as Parameters<RequestChannels[K]>))
      })
    )
  },
  removeListener<K extends keyof RequestChannels>(channel: K, callback: ChannelHandler<K>) {
    const handlers = listeners.get(channel)
    const remove = handlers?.get(callback)
    handlers?.delete(callback)
    if (handlers?.size === 0) listeners.delete(channel)
    void remove?.then(dispose => dispose()).catch(error => log.error("Unable to dispose event listener", error))
  },
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    switch (channel) {
      case "show-open-dialog": {
        const options = args[0] as OpenDialogOptions
        return open({
          directory: options.properties.includes("openDirectory"),
          multiple: false,
          defaultPath: options.defaultPath,
          title: options.title
        })
      }
      case "show-save-dialog": {
        const options = args[0] as SaveDialogOptions
        return save({ defaultPath: options.defaultPath, title: options.title })
      }

      case "request-notifications-permission":
        return notifications.requestNotificationsPermission()
      case "get-notifications-permission":
        return notifications.getNotificationsPermission()
      case "show-notification":
        return notifications.showNotification(
          String(args[0]),
          String(args[1]),
          args[2] as Record<string, unknown> | undefined
        )

      case "write-clipboard-text":
        if (typeof args[0] !== "string") throw new TypeError("Clipboard text must be a string")
        return navigator.clipboard.writeText(args[0])
      default:
        throw new Error(`Unsupported native request: ${channel}`)
    }
  },
  send(channel: string, ...args: unknown[]): void {
    switch (channel) {
      case "focus-window":
        void getCurrentWindow()
          .setFocus()
          .catch(error => log.error("Unable to focus window", error))
        return
      case "update-window-background-color":
        if (typeof args[0] !== "string") throw new TypeError("Background color must be a string")
        void getCurrentWebviewWindow()
          .setBackgroundColor(args[0])
          .catch(error => log.error("Unable to set window background", error))
        return
      case "dialog-did-open":
        void invoke("desktop_dialog_did_open").catch(error => log.error("Unable to notify about dialog", error))
        return
      default:
        throw new Error(`Unsupported native event: ${channel}`)
    }
  }
}

export const ipcRenderer = {
  on: transport.on,
  removeListener: transport.removeListener,
  invoke<K extends keyof RequestResponseChannels>(
    channel: K,
    ...args: Parameters<RequestResponseChannels[K]>
  ): ReturnType<RequestResponseChannels[K]> {
    return transport.invoke(channel, ...args) as ReturnType<RequestResponseChannels[K]>
  },
  send<K extends keyof RequestChannels>(channel: K, ...args: Parameters<RequestChannels[K]>): void {
    transport.send(channel, ...args)
  }
}
