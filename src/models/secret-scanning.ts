// Desktop MIT implementation extracted unchanged from ui/secret-scanning/bypass-push-protection-dialog.tsx.
export const BypassReason = {
  FalsePositive: "false_positive",
  UsedInTests: "used_in_tests",
  WillFixLater: "will_fix_later"
} as const
export type BypassReason = (typeof BypassReason)[keyof typeof BypassReason]

export type BypassReasonType = typeof BypassReason.FalsePositive | typeof BypassReason.UsedInTests | typeof BypassReason.WillFixLater
