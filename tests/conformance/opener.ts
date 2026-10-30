// Captures the OS browser-launch boundary; never reports an actual browser opened.
export const openedUrls: string[] = []
export async function openUrl(url: string): Promise<void> {
  openedUrls.push(url)
}
export async function openPath(_path: string): Promise<void> {
  throw new Error("Opening OS files is not available in the headless test runner")
}
export async function revealItemsInDir(_paths: string | string[]): Promise<void> {
  throw new Error("Revealing OS files is not available in the headless test runner")
}
