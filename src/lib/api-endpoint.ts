// Desktop endpoint helper, with Tauri build environment names.
export const envEndpoint: string | undefined = import.meta.env?.VITE_DESKTOP_GITHUB_DOTCOM_API_ENDPOINT
export function getDotComAPIEndpoint(): string {
  // NOTE:
  // `DESKTOP_GITHUB_DOTCOM_API_ENDPOINT` only needs to be set if you are
  // developing against a local version of GitHub the Website, and need to debug
  // the server-side interaction. For all other cases you should leave this
  // unset.
  if (envEndpoint && envEndpoint.length > 0) {
    return envEndpoint
  }

  return "https://api.github.com"
}
