import { CheckCircleFillIcon, DotFillIcon, SkipIcon, XCircleFillIcon } from "@primer/octicons-react"

/** Desktop ci-status.tsx 的图标与 _ci-status.scss 的颜色：成功绿勾、失败红叉、进行中黄点、跳过/取消灰色。 */
export function CIStatusIcon({ state }: { state: string }) {
  if (state === "success") return <CheckCircleFillIcon size={16} className="ci-status ci-status-success" />
  if (state === "failure" || state === "timed_out" || state === "action_required")
    return <XCircleFillIcon size={16} className="ci-status ci-status-failure" />
  if (state === "skipped" || state === "cancelled" || state === "neutral" || state === "stale")
    return <SkipIcon size={16} className="ci-status ci-status-skipped" />
  return <DotFillIcon size={16} className="ci-status ci-status-pending" />
}
