import type { Accounts } from "@/models/app-state"

/** 「我的」页签空着时该说什么。登录过但这次验证失败（断网、令牌被拒）不是没登录：
 *  失败的账号没有上次成功的缓存时 login 为空，只能从 error 看出它存在。 */
export type AccountEmptyState =
  { kind: "signedIn" } | { kind: "signedOut" } | { kind: "failed"; host: string; error: string }

export function accountEmptyState(accounts: Accounts): AccountEmptyState {
  const active = Object.entries(accounts).filter(([, account]) => !account.ignored)
  if (active.some(([, account]) => account.login)) return { kind: "signedIn" }
  const failed = active.find(([, account]) => account.error)
  return failed ? { kind: "failed", host: failed[0], error: failed[1].error! } : { kind: "signedOut" }
}
