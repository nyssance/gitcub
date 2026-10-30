// Desktop MIT implementation extracted unchanged from ui/secret-scanning/bypass-push-protection-dialog.tsx.
export enum BypassReason {
  FalsePositive = "false_positive",
  UsedInTests = "used_in_tests",
  WillFixLater = "will_fix_later"
}

export type BypassReasonType = BypassReason.FalsePositive | BypassReason.UsedInTests | BypassReason.WillFixLater
