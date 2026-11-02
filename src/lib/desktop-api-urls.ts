// Desktop URL helpers; Node URL.parse replaced by browser URL for absolute endpoints.
import { envEndpoint, getDotComAPIEndpoint } from "./api-endpoint"

export { getDotComAPIEndpoint } from "./api-endpoint"

import { isDotCom, isGHE } from "./endpoint-capabilities"

const envHTMLURL: string | undefined = import.meta.env?.VITE_DESKTOP_GITHUB_DOTCOM_HTML_URL
export type GitHubAccountType = "User" | "Organization"
export type EmailVisibility = "public" | "private" | null

/**
 * Information about a user's email as returned by the GitHub API.
 */
export interface IAPIEmail {
  readonly email: string
  readonly verified: boolean
  readonly primary: boolean
  readonly visibility: EmailVisibility
}

export function getHTMLURL(endpoint: string): string {
  if (envHTMLURL !== undefined) {
    return envHTMLURL
  }

  // In the case of GitHub.com, the HTML site lives on the parent domain.
  //  E.g., https://api.github.com -> https://github.com
  //
  // Whereas with Enterprise, it lives on the same domain but without the
  // API path:
  //  E.g., https://github.mycompany.com/api/v3 -> https://github.mycompany.com
  //
  // We need to normalize them.
  if (endpoint === getDotComAPIEndpoint() && !envEndpoint) {
    return "https://github.com"
  } else {
    if (isGHE(endpoint)) {
      const url = new window.URL(endpoint)

      url.pathname = "/"

      if (url.hostname.startsWith("api.")) {
        url.hostname = url.hostname.replace(/^api\./, "")
      }

      return url.toString()
    }

    const parsed = new URL(endpoint)
    return `${parsed.protocol}//${parsed.hostname}`
  }
}

/**
 * Get the API URL for an HTML URL. For example:
 *
 * http://github.mycompany.com -> https://github.mycompany.com/api/v3
 */
export function getEnterpriseAPIURL(endpoint: string): string {
  const { host } = new window.URL(endpoint)

  return isGHE(endpoint) ? `https://api.${host}/` : `https://${host}/api/v3`
}

export const getAPIEndpoint = (endpoint: string) =>
  isDotCom(endpoint) ? getDotComAPIEndpoint() : getEnterpriseAPIURL(endpoint)
