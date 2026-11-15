/** Narrow transport contracts shared by message-port/native image clients. */
export interface WebContents {
  readonly id: number
  isDestroyed(): boolean
  send(channel: "resolve-image-token", requestId: number, endpoint: string, token: string): void
  on(event: "destroyed", callback: () => void): void
}
export type IpcRendererEvent = object
export type ImageTokenListener = (event: IpcRendererEvent, requestId: number, endpoint: string, token: string) => void
export interface ImageTokenIPC {
  on(channel: "resolve-image-token", listener: ImageTokenListener): unknown
  removeListener(channel: "resolve-image-token", listener: ImageTokenListener): unknown
  send(channel: "resolved-image-token", requestId: number, token: string | null): unknown
}
export const send = (
  sender: WebContents,
  channel: "resolve-image-token",
  id: number,
  endpoint: string,
  token: string
) => sender.send(channel, id, endpoint, token)
