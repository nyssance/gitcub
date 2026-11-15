// Desktop MIT port; platform imports adapted to Tauri.
import { testForInvalidChars } from "../upstream/lib/sanitize-ref-name"

export interface IOAuthAction {
  readonly name: "oauth"
  readonly code: string
  readonly state: string
}

export interface IOpenRepositoryFromURLAction {
  readonly name: "open-repository-from-url"

  /** the remote repository location associated with the "Open in Desktop" action */
  readonly url: string

  /** the optional branch name which should be checked out. use the default branch otherwise. */
  readonly branch: string | null

  /** the pull request number, if pull request originates from a fork of the repository */
  readonly pr: string | null

  /** the file to open after cloning the repository */
  readonly filepath: string | null
}

export interface IUnknownAction {
  readonly name: "unknown"
  readonly url: string
}

export type URLActionType = IOAuthAction | IOpenRepositoryFromURLAction | IUnknownAction

/**
 * Parse the URL to find a given key in the querystring text.
 *
 * Like the legacy `querystring` object this returns the first value when the
 * key is repeated and `null` when the key is missing.
 *
 * @param query The querystring key-value pairs of the source URL
 * @param key The key to look for in the querystring
 */
function getQueryStringValue(query: URLSearchParams, key: string): string | null {
  return query.get(key)
}

export function parseAppURL(url: string): URLActionType {
  // The WHATWG `URL.parse` returns null instead of throwing, matching the
  // legacy `url.parse` which yielded a null hostname for unparsable input.
  const parsedURL = URL.parse(url)
  const hostname = parsedURL?.hostname
  const unknown: IUnknownAction = { name: "unknown", url }
  if (!hostname) {
    return unknown
  }

  const query = parsedURL.searchParams

  const actionName = hostname.toLowerCase()
  if (actionName === "oauth") {
    const code = getQueryStringValue(query, "code")
    const state = getQueryStringValue(query, "state")
    if (code != null && state != null) {
      return { name: "oauth", code, state }
    } else {
      return unknown
    }
  }

  // we require something resembling a URL first
  // - bail out if it's not defined
  // - bail out if you only have `/`
  const pathName = parsedURL.pathname
  if (!pathName || pathName.length <= 1) {
    return unknown
  }

  // Trim the trailing / from the URL
  const parsedPath = pathName.slice(1)

  if (actionName === "openrepo") {
    const pr = getQueryStringValue(query, "pr")
    const branch = getQueryStringValue(query, "branch")
    const filepath = getQueryStringValue(query, "filepath")

    if (pr != null) {
      if (!/^\d+$/.test(pr)) {
        return unknown
      }

      // we also expect the branch for a forked PR to be a given ref format
      if (branch != null && !/^pr\/\d+$/.test(branch)) {
        return unknown
      }
    }

    if (branch != null && testForInvalidChars(branch)) {
      return unknown
    }

    return {
      name: "open-repository-from-url",
      url: parsedPath,
      branch,
      pr,
      filepath
    }
  }

  return unknown
}
