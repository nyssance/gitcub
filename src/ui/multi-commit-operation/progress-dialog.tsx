// Desktop MIT port of ui/multi-commit-operation/dialog/progress-dialog.tsx; written as a function component.
import { useTranslation } from "react-i18next"

import type { IMultiCommitOperationProgress } from "@/upstream/models/progress"

import type { Emoji } from "../../upstream/lib/emoji"
import { Dialog, DialogContent } from "../desktop/dialog"
import { RichText } from "../desktop/rich-text"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"

/** Desktop lib/rebase.ts formatRebaseValue：限制在 0–1，保留两位有效小数 */
function formatRebaseValue(value: number) {
  return Math.round(Math.min(Math.max(value, 0), 1) * 100) / 100
}

interface Props {
  /** Desktop 传的是首字母大写的操作名（Rebase、Cherry-pick、Squash、Reorder），这里是它的标题 */
  readonly title: string
  readonly progress: IMultiCommitOperationProgress
  readonly emoji: Map<string, Emoji>
}

export function ProgressDialog({ title, progress, emoji }: Props) {
  const { t } = useTranslation()
  const { position, totalCommitCount, value, currentCommitSummary } = progress

  const progressValue = formatRebaseValue(value)
  return (
    <Dialog dismissDisabled={true} id="multi-commit-progress" title={title}>
      <DialogContent>
        <div>
          <progress value={progressValue} />

          <div className="details">
            <div className="green-circle">
              <Octicon symbol={octicons.check} />
            </div>
            <div className="summary">
              <div className="message">
                {t("multiCommitOperation.commitPositionOfTotal", { position, total: totalCommitCount })}
              </div>
              <div className="detail">
                <RichText emoji={emoji} text={currentCommitSummary || ""} />
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
