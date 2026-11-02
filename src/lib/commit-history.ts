// Desktop commit hydration; native history preserves raw identities and unfolded trailers.
import { invoke } from "@tauri-apps/api/core"

import { Commit } from "../models/commit"
import type { CommitDetails } from "../models/history"
import { CommitIdentity } from "../upstream/models/commit-identity"
import { parseRawUnfoldedTrailers } from "./commit-trailers"

export async function getCommits(
  repository: { path: string },
  revision?: string,
  limit?: number,
  skip?: number,
  additional: readonly string[] = []
): Promise<readonly Commit[]> {
  const parsed = await invoke<CommitDetails[]>("commit_details", {
    repo: repository.path,
    revision: revision ?? null,
    limit: limit ?? null,
    skip: skip ?? null,
    additional
  })
  return parsed.map(commit => {
    // Ref is of the format: (HEAD -> master, tag: some-tag-name, tag: some-other-tag,with-a-comma, origin/master, origin/HEAD)
    // Refs are comma separated, but some like tags can also contain commas in the name, so we split on the pattern ", " and then
    // check each ref for the tag prefix. We used to use the regex /tag: ([^\s,]+)/g)`, but will clip a tag with a comma short.
    const tags = commit.refs
      .toString()
      .split(", ")
      .flatMap(ref => (ref.startsWith("tag: ") ? ref.slice(5) : []))

    return new Commit(
      commit.sha.toString(),
      commit.shortSha.toString(),
      commit.summary,
      commit.body,
      CommitIdentity.parseIdentity(commit.author.toString()),
      CommitIdentity.parseIdentity(commit.committer.toString()),
      commit.parents.length > 0 ? commit.parents.toString().split(" ") : [],
      // We know for sure that the trailer separator will be ':' since we got
      // them from %(trailers:unfold) above, see `git help log`:
      //
      //   "key_value_separator=<SEP>: specify a separator inserted between
      //    trailer lines. When this option is not given each trailer key-value
      //    pair is separated by ": ". Otherwise it shares the same semantics as
      //    separator=<SEP> above."
      parseRawUnfoldedTrailers(commit.trailers.toString(), ":"),
      tags
    )
  })
}
