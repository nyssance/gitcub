import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type { PullRequest, Remote } from "@/models/app-state"

import { NativeChecks } from "../check-runs/native-checks"
import { CIStatusIcon } from "../pull-requests/ci-status-icon"

/** Desktop pull-request-badge.tsx：分支按钮里当前分支的 PR 编号与 CI 状态。
 *  有 CI 状态时才可点，点开检查项弹层（原版 CICheckRunPopover，本项目是 NativeChecks）。 */
export function PullRequestBadge({ request, remote }: { request: PullRequest; remote: Remote }) {
  const { t } = useTranslation()
  const badge = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const hasStatus = !!request.checks && !!request.headSha
  return (
    <>
      <button
        ref={badge}
        type="button"
        className="pr-badge"
        disabled={!hasStatus}
        aria-haspopup={true}
        aria-expanded={open}
        aria-label={`#${request.number}${hasStatus ? ` ${t("pr.checksDetail")}` : ""}`}
        onClick={event => {
          event.stopPropagation()
          if (hasStatus) setOpen(value => !value)
        }}>
        <span className="number">#{request.number}</span>
        {request.checks && <CIStatusIcon state={request.checks} />}
      </button>
      {open && badge.current && (
        <NativeChecks
          key={`${remote.host}/${remote.owner}/${remote.name}/${request.headSha}`}
          remote={remote}
          request={request}
          anchor={badge.current}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
