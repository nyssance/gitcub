/* eslint-disable no-constant-condition, object-shorthand, unicorn/prefer-logical-operator-over-ternary, unicorn/prefer-string-raw, unicorn/prefer-string-replace-all -- Preserve the GitLens implementation verbatim. */
// GitLens packages/git/src/utils/autolink.utils.ts (c1f6e5f3c) ported one to one, with the
// packages/git/src/models/autolink.ts types and the two packages/utils/src/string.ts helpers it
// imports copied verbatim. The upstream snapshots live under tests/conformance/upstream/gitlens.
// MIT, see NOTICE.md.

// packages/utils/src/types.ts
type RequireSome<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: T[P] }

// packages/git/src/models/remoteProvider.ts
export interface ProviderReference {
  readonly id: string
  readonly name: string
  readonly domain: string
  readonly icon: string
}

// packages/git/src/models/resourceDescriptor.ts
export type ResourceDescriptor = { key: string } & Record<string, unknown>

// packages/git/src/models/autolink.ts
export type AutolinkType = "issue" | "pullrequest"
export type AutolinkReferenceType = "commit" | "branch"

export interface AutolinkReference {
  /** Short prefix to match to generate autolinks for the external resource */
  readonly prefix: string
  /** URL of the external resource to link to */
  readonly url: string
  /** Whether alphanumeric characters should be allowed in `<num>` */
  readonly alphanumeric: boolean
  /** Whether case should be ignored when matching the prefix */
  readonly ignoreCase: boolean
  readonly title: string | undefined

  readonly type?: AutolinkType
  readonly referenceType?: AutolinkReferenceType
  readonly description?: string
  readonly descriptor?: ResourceDescriptor
}

export interface Autolink extends Omit<CacheableAutolinkReference, "id"> {
  provider?: ProviderReference
  id: string
}

export interface CacheableAutolinkReference extends AutolinkReference {
  id?: never

  messageHtmlRegex?: RegExp
  messageMarkdownRegex?: RegExp
  messageRegex?: RegExp
  branchNameRegexes?: RegExp[]
}

/** Metadata for rendering a dynamic autolink pattern in text */
export interface DynamicAutolinkDescriptor {
  /** Regex with /g flag. Must capture groups: (fullMatch, repo, num) */
  readonly regex: RegExp
  /** Builds URL from matched groups. Receives raw matched text — renderer handles escaping. */
  readonly url: (repo: string, num: string) => string
  /** Hover title for the link */
  readonly title: (repo: string, num: string) => string
  /** Label for footnotes */
  readonly label: (repo: string, num: string) => string
}

export interface DynamicAutolinkReference {
  parse: (text: string, autolinks: Map<string, Autolink>) => void
  /** Descriptors for rendering dynamic autolinks in text. If absent, dynamic autolinks are parsed but not rendered as links. */
  readonly descriptors?: readonly DynamicAutolinkDescriptor[]
}

export type RefSet = [
  ProviderReference | undefined,
  (AutolinkReference | DynamicAutolinkReference)[] | CacheableAutolinkReference[]
]

// packages/utils/src/string.ts
export function encodeHtmlWeak(s: string): string
export function encodeHtmlWeak(s: string | undefined): string | undefined
export function encodeHtmlWeak(s: string | undefined): string | undefined {
  return s?.replace(/[<>&"]/g, c => {
    switch (c) {
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case "&":
        return "&amp;"
      case '"':
        return "&quot;"
      default:
        return c
    }
  })
}

export function escapeRegex(s: string): string {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")
}

// packages/git/src/utils/autolink.utils.ts
export function serializeAutolink(value: Autolink): Autolink {
  const serialized: Autolink = {
    provider: value.provider
      ? {
          id: value.provider.id,
          name: value.provider.name,
          domain: value.provider.domain,
          icon: value.provider.icon
        }
      : undefined,
    id: value.id,
    prefix: value.prefix,
    url: value.url,
    alphanumeric: value.alphanumeric,
    ignoreCase: value.ignoreCase,
    title: value.title,
    type: value.type,
    description: value.description,
    descriptor: value.descriptor
  }
  return serialized
}

export function isDynamic(ref: AutolinkReference | DynamicAutolinkReference): ref is DynamicAutolinkReference {
  return !("prefix" in ref) && !("url" in ref)
}

export function isCacheable(ref: AutolinkReference | DynamicAutolinkReference): ref is CacheableAutolinkReference {
  return "prefix" in ref && ref.prefix != null && "url" in ref && ref.url != null
}

export function ensureCachedRegex(
  ref: Autolink | CacheableAutolinkReference,
  outputFormat: "html"
): asserts ref is RequireSome<CacheableAutolinkReference, "messageHtmlRegex">
export function ensureCachedRegex(
  ref: Autolink | CacheableAutolinkReference,
  outputFormat: "markdown"
): asserts ref is RequireSome<CacheableAutolinkReference, "messageMarkdownRegex">
export function ensureCachedRegex(
  ref: Autolink | CacheableAutolinkReference,
  outputFormat: "plaintext"
): asserts ref is RequireSome<CacheableAutolinkReference, "messageRegex">
export function ensureCachedRegex(
  ref: Autolink | CacheableAutolinkReference,
  outputFormat: "html" | "markdown" | "plaintext"
): void {
  // If the ref is a matched Autolink then only match the exact `id`
  const refPattern = ref.id ? ref.id : ref.alphanumeric ? "\\w+" : "\\d+"
  const refFlags = !ref.id && ref.ignoreCase ? "gi" : "g"

  // Regexes matches the ref prefix followed by a token (e.g. #1234)
  if (outputFormat === "markdown") {
    ref.messageMarkdownRegex ??= new RegExp(
      `(^|\\s|\\(|\\[|\\{)(${escapeRegex(encodeHtmlWeak(ref.prefix))}(${refPattern}))\\b`,
      refFlags
    )
  } else if (outputFormat === "html") {
    ref.messageHtmlRegex ??= new RegExp(
      `(^|\\s|\\(|\\[|\\{)(${escapeRegex(encodeHtmlWeak(ref.prefix))}(${refPattern}))\\b`,
      refFlags
    )
  } else {
    ref.messageRegex ??= new RegExp(`(^|\\s|\\(|\\[|\\{)(${escapeRegex(ref.prefix)}(${refPattern}))\\b`, refFlags)
  }
}

export function ensureCachedBranchNameRegexes(
  ref: CacheableAutolinkReference
): asserts ref is RequireSome<CacheableAutolinkReference, "branchNameRegexes"> {
  if (ref.prefix?.length > 0) {
    ref.branchNameRegexes ??= [
      // Rule 1: Any prefixed ref followed by a 2+ digit number and either a connector or end-of-string after it
      new RegExp(`(?<prefix>${ref.prefix})(?<issueKeyNumber>\\d{2,})(?:[\\/\\-\\_\\.]|$)`, "i")
    ]
  } else {
    ref.branchNameRegexes ??= [
      // Rule 2: Any 2+ digit number preceded by feature|feat|fix|bug|bugfix|hotfix|issue|ticket with a connector before it, and either a connector or end-of-string after it
      new RegExp(
        `(?:feature|feat|fix|bug|bugfix|hotfix|issue|ticket)(?:\\/#|-#|_#|\\.#|[\\/\\-\\_\\.#])(?<issueKeyNumber>\\d{2,})(?:[\\/\\-\\_\\.]|$)`,
        "i"
      ),
      // Rule 3.1: Any 3+ digit number preceded by at least two non-slash, non-numeric characters
      new RegExp(`(?:[^\\d/]{2})(?<issueKeyNumber>\\d{3,})`, "i"),
      // Rule 3.2: Any 3+ digit number followed by at least two non-slash, non-numeric characters
      new RegExp(`(?<issueKeyNumber>\\d{3,})(?:[^\\d/]{2})`, "i"),
      // Rule 3.3: A 3+ digit number is the entire branch name
      new RegExp(`^(?<issueKeyNumber>\\d{3,})$`, "i")
    ]
  }
}

export const numRegex = /<num>/g

export function getAutolinks(message: string, refsets: Readonly<RefSet[]>): Map<string, Autolink> {
  const autolinks = new Map<string, Autolink>()

  let match
  let num
  for (const [provider, refs] of refsets) {
    for (const ref of refs) {
      if (!isCacheable(ref) || (ref.referenceType && ref.referenceType !== "commit")) {
        if (isDynamic(ref)) {
          ref.parse(message, autolinks)
        }
        continue
      }

      ensureCachedRegex(ref, "plaintext")

      do {
        match = ref.messageRegex.exec(message)
        if (!match) break

        ;[, , , num] = match

        autolinks.set(num, {
          provider: provider,
          id: num,
          prefix: ref.prefix,
          url: ref.url?.replace(numRegex, num),
          alphanumeric: ref.alphanumeric,
          ignoreCase: ref.ignoreCase,
          title: ref.title?.replace(numRegex, num),
          type: ref.type,
          description: ref.description?.replace(numRegex, num),
          descriptor: ref.descriptor
        })
      } while (true)
    }
  }

  return autolinks
}

export function getBranchAutolinks(
  branchName: string,
  refsets: Readonly<RefSet[]>,
  priorityProviderIds?: string[]
): Map<string, Autolink> {
  const autolinks = new Map<string, Autolink>()

  let num
  let match
  // Sort refsets so that priority integrations (e.g. issue trackers) are checked first for matches
  const sortedRefSets = refsets.toSorted((a, b) => {
    if (priorityProviderIds != null) {
      if (a[0]?.id && priorityProviderIds.includes(a[0].id)) {
        return -1
      }
      if (b[0]?.id && priorityProviderIds.includes(b[0].id)) {
        return 1
      }
    }
    return 0
  })

  for (const [provider, refs] of sortedRefSets) {
    for (const ref of refs) {
      if (!isCacheable(ref) || ref.type === "pullrequest" || (ref.referenceType && ref.referenceType !== "branch")) {
        continue
      }

      ensureCachedBranchNameRegexes(ref)
      for (const regex of ref.branchNameRegexes) {
        match = branchName.match(regex)
        if (!match?.groups) continue

        num = match.groups.issueKeyNumber
        const linkUrl = ref.url?.replace(numRegex, num)
        autolinks.set(linkUrl, {
          ...ref,
          provider: provider,
          id: num,
          url: linkUrl,
          title: ref.title?.replace(numRegex, num),
          description: ref.description?.replace(numRegex, num),
          descriptor: ref.descriptor
        })

        // Stop at the first match
        return autolinks
      }
    }
  }

  return autolinks
}
