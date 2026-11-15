// Desktop MIT unchanged changelog parsing functions.
export function findReleaseNote(body: string): string | null | undefined {
  const re = /^Notes: (.+)$/gm
  let lastMatches = null

  // There might be multiple lines starting with "Notes: ", but we're only
  // interested in the last one.
  let matches = re.exec(body)
  while (matches) {
    lastMatches = matches
    matches = re.exec(body)
  }

  if (!lastMatches || lastMatches.length < 2) {
    return undefined
  }

  const note = lastMatches[1].replace(/\.$/, "")
  return note === "no-notes" ? null : note
}

export function findIssueRef(body: string): string {
  let issueRef = ""

  const re = /(close[s]?|fix(e[sd])?|resolve[sd]):?\s*#(\d+)/gi
  let match: RegExpExecArray | null
  do {
    match = re.exec(body)
    if (match?.length === 4) {
      // a match should always have four elements - the matching text
      // as well as the three groups within the match. We're only
      // interested in the last group - the issue reference number
      issueRef += ` #${match[3]}`
    }
  } while (match)

  return issueRef
}
