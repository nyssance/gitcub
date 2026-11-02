// Desktop MIT implementation extracted from lib/git/log.ts (getAuthors); node:assert has no WebView build,
// so the length check throws the same message directly.

import type { Repository } from "../../models/repository"
import { CommitIdentity } from "../../upstream/models/commit-identity"
import { executeGit as git } from "../git-execution"

export async function getAuthors(repository: Repository, shas: string[]) {
  if (shas.length === 0) {
    return []
  }

  const { stdout } = await git(
    ["log", "--format=format:%an <%ae> %ad", "--no-walk=unsorted", "--date=raw", "-z", "--stdin"],
    repository.path,
    "getAuthors",
    { stdin: shas.join("\n") }
  )

  const authors = stdout.split("\0").map(CommitIdentity.parseIdentity)

  // This can happen if there are duplicate shas in the input, git log will only
  // return the author once for each sha.
  if (authors.length !== shas.length) throw new Error("Commit to author mismatch")

  return authors
}
