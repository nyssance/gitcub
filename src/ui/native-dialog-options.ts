export interface OpenDialogOptions {
  properties: readonly string[]
  defaultPath?: string
  title?: string
}
export interface SaveDialogOptions {
  defaultPath?: string
  title?: string
  buttonLabel?: string
  nameFieldLabel?: string
  showsTagField?: boolean
  properties?: readonly string[]
}
