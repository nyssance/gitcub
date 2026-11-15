export interface FileErrorDispatcher {
  postError(error: { name: string; message: string }): void | Promise<void>
}
