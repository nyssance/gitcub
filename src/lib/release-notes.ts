// Desktop MIT implementation extracted unchanged from lib/release-notes.ts.
import type { ReleaseMetadata, ReleaseNote, ReleaseSummary } from "../upstream/models/release-notes"
import { formatDate } from "./format-date"

// expects a release note entry to contain a header and then some text
// example:
//    [New] Fallback to Gravatar for loading avatars - #821
const itemEntryRe = /^\[([a-z]{1,})\]\s((.|\n)*)/i

function parseEntry(note: string): ReleaseNote | null {
  const text = note.trim()
  const match = itemEntryRe.exec(text)
  if (match === null) {
    log.debug(`[ReleaseNotes] unable to convert text into entry: ${note}`)
    return null
  }

  const kind = match[1].toLowerCase()
  const message = match[2]
  if (
    kind === "new" ||
    kind === "fixed" ||
    kind === "improved" ||
    kind === "added" ||
    kind === "pretext" ||
    kind === "removed"
  ) {
    return { kind, message }
  }

  log.debug(`[ReleaseNotes] kind ${kind} was found but is not a valid entry`)

  return {
    kind: "other",
    message
  }
}

/**
 * A filter function with type predicate to return non-null and non-undefined
 * entries while also satisfying the TS compiler
 *
 * Source: https://stackoverflow.com/a/46700791/1363815
 */
function notEmpty<TValue>(value: TValue | null | undefined): value is TValue {
  return value !== null && value !== undefined
}

export function parseReleaseEntries(notes: ReadonlyArray<string>): ReadonlyArray<ReleaseNote> {
  return notes.map(n => parseEntry(n)).filter(notEmpty)
}

export function getReleaseSummary(latestRelease: ReleaseMetadata): ReleaseSummary {
  const entries = parseReleaseEntries(latestRelease.notes)

  const enhancements = entries.filter(e => e.kind === "new" || e.kind === "added" || e.kind === "improved")
  const bugfixes = entries.filter(e => e.kind === "fixed")
  const other = entries.filter(e => e.kind === "removed" || e.kind === "other")
  const thankYous = entries.filter(e => e.message.includes(" Thanks @"))
  const pretext = entries.filter(e => e.kind === "pretext")

  return {
    latestVersion: latestRelease.version,
    datePublished: formatDate(new Date(latestRelease.pub_date), {
      time: false,
      dateStyle: "long"
    }),
    pretext,
    enhancements,
    bugfixes,
    other,
    thankYous
  }
}
