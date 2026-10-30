// Desktop MIT port; platform imports adapted to Tauri.
import type {
  ValidNotificationPullRequestReview,
  ValidNotificationPullRequestReviewState
} from "../../lib/valid-notification-pull-request-review"
import * as octicons from "../../upstream/ui/octicons/octicons.generated"
import type { OcticonSymbol } from "../octicons"

/** Returns the user-facing verb for a given review's state. */
export function getVerbForPullRequestReview(review: ValidNotificationPullRequestReview) {
  switch (review.state) {
    case "APPROVED":
      return "approved"
    case "CHANGES_REQUESTED":
      return "requested changes on"
    case "COMMENTED":
      return "reviewed"
  }
}

type ReviewStateIcon = {
  symbol: OcticonSymbol
  className: string
}

/** Returns the icon info (symbol and class) for a given review's state. */
export function getPullRequestReviewStateIcon(state: ValidNotificationPullRequestReviewState): ReviewStateIcon {
  switch (state) {
    case "APPROVED":
      return {
        symbol: octicons.check,
        className: "pr-review-approved"
      }
    case "CHANGES_REQUESTED":
      return {
        symbol: octicons.fileDiff,
        className: "pr-review-changes-requested"
      }
    case "COMMENTED":
      return {
        symbol: octicons.eye,
        className: "pr-review-commented"
      }
  }
}
