import groupBy from "lodash/groupBy"

import { toSentence } from "../../upstream/lib/to_sentence"
import type { APICheckConclusion } from "../api"
import i18n from "../i18n"
import { getCheckRunConclusionAdjective } from "./ci-checks"

export function getCombinedStatusSummary(
  statusHolders: ReadonlyArray<{ conclusion: APICheckConclusion | null }>,
  description?: "check" | "step"
): string {
  if (i18n.language.startsWith("zh")) {
    const labels: Record<string, string> = {
      success: "通过",
      failure: "失败",
      neutral: "中立",
      skipped: "跳过",
      cancelled: "取消",
      timed_out: "超时",
      action_required: "需要操作",
      stale: "过期",
      startup_failure: "启动失败"
    }
    return Object.values(groupBy(statusHolders, "conclusion"))
      .map(
        group =>
          `${group.length} 项${description === "step" ? "步骤" : "检查"}${labels[group[0].conclusion ?? ""] ?? "进行中"}`
      )
      .join("，")
  }
  const conclusions = Object.values(groupBy(statusHolders, "conclusion")).map(
    g => `${g.length} ${getCheckRunConclusionAdjective(g[0].conclusion).toLocaleLowerCase()}`
  )

  const pluralize = statusHolders.length > 1 ? `${description}s` : description
  return `${toSentence(conclusions)} ${pluralize}`
}
