// Desktop MIT implementation extracted unchanged from lib/git/stash.ts.
import type { Repository } from "../../models/repository"
import type { CommittedFileChange } from "../../upstream/models/status"
import { executeGit as git } from "../git-execution"
import { parseRawLogWithNumstat } from "./raw-log"
export async function getStashedFiles(
  repository: Repository,
  stashSha: string
): Promise<ReadonlyArray<CommittedFileChange>> {
  const args = ["stash", "show", stashSha, "--raw", "--numstat", "-z", "--format=format:", "--no-show-signature", "--"]

  const { stdout } = await git(args, repository.path, "getStashedFiles")

  return parseRawLogWithNumstat(stdout, stashSha, `${stashSha}^`).files
}
