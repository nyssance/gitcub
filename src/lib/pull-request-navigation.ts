import type { Remote } from "../models/app-state"

export interface PullRequestTargets {
  kind: "github" | "gitlab"
  sourceId: number
  remote: Remote
  targets: { fullName: string; id: number; defaultBranch: string; branches: string[] }[]
}

/** Creation, discussion, reviews and merging remain on the hosting platform. */
export function pullRequestCreationURL(
  context: PullRequestTargets,
  targetIndex: number,
  head: string,
  base: string
): string {
  const target = context.targets[targetIndex]
  if (!target || !head || !base) throw new Error("Missing pull request source or target")
  const root = `https://${context.remote.host}/${target.fullName.split("/").map(encodeURIComponent).join("/")}`
  if (context.kind === "github") {
    const source = `${context.remote.owner}:${head}`
    return `${root}/compare/${encodeURIComponent(base)}...${encodeURIComponent(source)}?expand=1`
  }
  const query = new URLSearchParams({
    "merge_request[source_project_id]": String(context.sourceId),
    "merge_request[target_project_id]": String(target.id),
    "merge_request[source_branch]": head,
    "merge_request[target_branch]": base
  })
  return `${root}/-/merge_requests/new?${query}`
}
