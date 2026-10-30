import { useTranslation } from "react-i18next"

import { Alert, AlertDescription } from "@/ui/base/alert"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/base/tooltip"

/** Keep service diagnostics readable without displacing the Git workflow. */
export function InlineError({ error }: { error: string }) {
  const { t } = useTranslation()
  // Desktop 对 404 的说法：找不到不一定是不存在，私有仓库对无权限的账号同样是 404（api.ts fetchRepositoryCloneInfo）。
  const summary = /rate limit exceeded|secondary rate limit/i.test(error)
    ? t("errors.rateLimited")
    : /^(?:[^:\s]+: )?HTTP 404\b/.test(error)
      ? t("errors.notFound")
      : /^(?:[^:\s]+: )?HTTP 403\b/.test(error)
        ? t("errors.forbidden")
        : error
  return (
    <Alert variant="destructive" className="min-w-0 shrink-0 rounded-none border-0 border-b px-3 py-2">
      <Tooltip>
        <AlertDescription className="text-destructive! min-w-0">
          <TooltipTrigger render={<span />} tabIndex={0} className="block truncate">
            {summary}
          </TooltipTrigger>
        </AlertDescription>
        <TooltipContent className="max-w-sm wrap-anywhere" align="start">
          {error}
        </TooltipContent>
      </Tooltip>
    </Alert>
  )
}
