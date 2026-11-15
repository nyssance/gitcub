// Desktop MIT: original merged branch query.

import type { Repository } from "../../models/repository"
import { executeGit as git } from "../git-execution"
import { createForEachRefParser } from "./for-each-ref-parser"
import { formatAsLocalRef } from "./refs"
export async function getMergedBranches(repository: Repository, branchName: string): Promise<Map<string, string>> {
  const canonicalBranchRef = formatAsLocalRef(branchName)
  const { formatArgs, parse } = createForEachRefParser({
    sha: "%(objectname)",
    canonicalRef: "%(refname)"
  })

  const args = ["branch", ...formatArgs, "--merged", branchName]
  const mergedBranches = new Map<string, string>()
  const { stdout } = await git(args, repository.path, "mergedBranches")

  for (const branch of parse(stdout)) {
    // Don't include the branch we're using to compare against
    // in the list of branches merged into that branch.
    if (branch.canonicalRef !== canonicalBranchRef) {
      mergedBranches.set(branch.canonicalRef, branch.sha)
    }
  }

  return mergedBranches
}
