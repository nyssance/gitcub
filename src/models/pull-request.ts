// Desktop MIT port; imports adapted to Tauri.
import type { GitHubRepository } from "./github-repository"

/** Returns the commit ref for a given pull request number. */
export function getPullRequestCommitRef(pullRequestNumber: number) {
  return `refs/pull/${pullRequestNumber}/head`
}

export class PullRequestRef {
  /**
   * @param ref The name of the ref.
   * @param sha The SHA of the ref.
   * @param gitHubRepository The GitHub repository in which this ref lives. It could be null if the
   *                         repository was deleted after the PR was opened.
   */
  public readonly ref: string
  public readonly sha: string
  public readonly gitHubRepository: GitHubRepository

  public constructor(ref: string, sha: string, gitHubRepository: GitHubRepository) {
    this.ref = ref
    this.sha = sha
    this.gitHubRepository = gitHubRepository
  }
}

export class PullRequest {
  /**
   * @param created The date on which the PR was created.
   * @param status The status of the PR. This will be `null` if we haven't looked up its
   *               status yet or if an error occurred while looking it up.
   * @param title The title of the PR.
   * @param number The number.
   * @param head The ref from which the pull request's changes are coming.
   * @param base The ref which the pull request is targeting.
   * @param author The author's login.
   */
  public readonly created: Date
  public readonly title: string
  public readonly pullRequestNumber: number
  public readonly head: PullRequestRef
  public readonly base: PullRequestRef
  public readonly author: string
  public readonly draft: boolean
  public readonly body: string

  public constructor(
    created: Date,
    title: string,
    pullRequestNumber: number,
    head: PullRequestRef,
    base: PullRequestRef,
    author: string,
    draft: boolean,
    body: string
  ) {
    this.created = created
    this.title = title
    this.pullRequestNumber = pullRequestNumber
    this.head = head
    this.base = base
    this.author = author
    this.draft = draft
    this.body = body
  }
}

/** The types of pull request suggested next actions */
export const PullRequestSuggestedNextAction = {
  PreviewPullRequest: "PreviewPullRequest",
  CreatePullRequest: "CreatePullRequest"
} as const
export type PullRequestSuggestedNextAction =
  (typeof PullRequestSuggestedNextAction)[keyof typeof PullRequestSuggestedNextAction]

/** Type guard which narrows a string to a PullRequestSuggestedNextAction */
export function isIdPullRequestSuggestedNextAction(
  id: string
): id is typeof PullRequestSuggestedNextAction.PreviewPullRequest | typeof PullRequestSuggestedNextAction.CreatePullRequest {
  return (
    id === PullRequestSuggestedNextAction.PreviewPullRequest || id === PullRequestSuggestedNextAction.CreatePullRequest
  )
}

export const defaultPullRequestSuggestedNextAction = PullRequestSuggestedNextAction.PreviewPullRequest
