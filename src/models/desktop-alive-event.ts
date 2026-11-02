// Desktop MIT event payloads.
export interface IDesktopChecksFailedAliveEvent {
  readonly type: "pr-checks-failed"
  readonly timestamp: number
  readonly owner: string
  readonly repo: string
  readonly pull_request_number: number
  readonly check_suite_id: number
  readonly commit_sha: string
}

export interface IDesktopPullRequestReviewSubmitAliveEvent {
  readonly type: "pr-review-submit"
  readonly timestamp: number
  readonly owner: string
  readonly repo: string
  readonly pull_request_number: number
  readonly state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"
  readonly review_id: string
}

export interface IDesktopPullRequestCommentAliveEvent {
  readonly type: "pr-comment"
  readonly subtype: "review-comment" | "issue-comment"
  readonly timestamp: number
  readonly owner: string
  readonly repo: string
  readonly pull_request_number: number
  readonly comment_id: string
}

/** Represents an Alive event relevant to Desktop. */
export type DesktopAliveEvent =
  IDesktopChecksFailedAliveEvent | IDesktopPullRequestReviewSubmitAliveEvent | IDesktopPullRequestCommentAliveEvent
