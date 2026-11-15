// Desktop MIT port; platform imports adapted to Tauri.
export function urlWithoutCredentials(remoteUrl: string | URL): string {
  const url = new URL(remoteUrl)
  url.username = ""
  url.password = ""
  return url.toString()
}
