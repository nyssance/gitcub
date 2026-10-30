// Desktop MIT implementation extracted unchanged from lib/git/checkout.ts.
import type { Repository } from "../../models/repository"
import { executeGit as git } from "../git-execution"
export async function checkoutPaths(repository: Repository, paths: ReadonlyArray<string>): Promise<void> {
  await git(["checkout", "HEAD", "--", ...paths], repository.path, "checkoutPaths")
}

/**
 * Check out either stage #2 (ours) or #3 (theirs) for a conflicted
 * file.
 */
