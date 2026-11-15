// Desktop MIT port; imports adapted to Tauri.
import uniqWith from "lodash/uniqWith"

import type { Commit } from "../models/commit"
import type { KnownAuthor } from "../upstream/models/author"

export function getUniqueCoauthorsAsAuthors(commits: ReadonlyArray<Commit>): ReadonlyArray<KnownAuthor> {
  const allCommitsCoAuthors = commits.flatMap(c => c.coAuthors)

  const uniqueCoAuthors = uniqWith(allCommitsCoAuthors, (a, b) => a.email === b.email && a.name === b.name)

  return uniqueCoAuthors.map(ca => {
    return { kind: "known", name: ca.name, email: ca.email, username: null }
  })
}
