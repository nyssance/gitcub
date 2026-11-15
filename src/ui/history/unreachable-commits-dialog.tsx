import { formatDistanceToNowStrict } from "date-fns"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { dateFnsLocale } from "@/lib/date-locales"
import type { CommitInfo } from "@/models/history"

import { LinkButton } from "../desktop/link-button"

export type CommitReachabilityTab = "unreachable" | "reachable"

/** Desktop UnreachableCommitsDialog：多选提交时哪些在这份 diff 里（沿最新那个的父提交能走到）、哪些不在。 */
export function UnreachableCommitsDialog({
  selectedShas,
  shasInDiff,
  commitLookup,
  selectedTab,
  onTabChange,
  onDismissed
}: {
  /** 当前选中的提交 */
  selectedShas: ReadonlyArray<string>
  /** diff 里包含的提交 */
  shasInDiff: ReadonlyArray<string>
  commitLookup: ReadonlyMap<string, CommitInfo>
  selectedTab: CommitReachabilityTab
  onTabChange: (tab: CommitReachabilityTab) => void
  onDismissed: () => void
}) {
  const { t, i18n } = useTranslation()
  const shas = selectedTab === "reachable" ? shasInDiff : selectedShas.filter(sha => !shasInDiff.includes(sha))
  return (
    <Dialog open onOpenChange={open => !open && onDismissed()}>
      <DialogContent className="unreachable-commits gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("history.commitReachability")}</DialogTitle>
        </DialogHeader>
        <Tabs
          value={selectedTab}
          onValueChange={value => (value === "reachable" || value === "unreachable") && onTabChange(value)}>
          <TabsList>
            <TabsTrigger value="unreachable">{t("history.unreachable")}</TabsTrigger>
            <TabsTrigger value="reachable">{t("history.reachable")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="message text-sm">
          {t(
            selectedTab === "unreachable"
              ? "history.youWillNotSeeChangesFromTheFollowingCommits"
              : "history.youWillSeeChangesFromTheFollowingCommits",
            { count: shas.length }
          )}{" "}
          <LinkButton uri="https://github.com/desktop/desktop/blob/development/docs/learn-more/unreachable-commits.md">
            {t("history.learnMoreAboutUnreachableCommits")}
          </LinkButton>
        </p>
        <ul className="unreachable-commit-list max-h-64 min-h-40 overflow-auto rounded-md border">
          {shas.map(sha => {
            const commit = commitLookup.get(sha)
            return (
              <li key={sha} className="border-b px-3 py-2 last:border-b-0">
                <div className="truncate text-sm" title={commit?.summary}>
                  {commit?.summary || t("history.emptyCommitMessage")}
                </div>
                <div className="text-muted-foreground truncate text-xs">
                  {commit
                    ? `${commit.authorName} · ${formatDistanceToNowStrict(commit.time * 1000, { addSuffix: true, locale: dateFnsLocale(i18n.language) })}`
                    : sha.slice(0, 7)}
                </div>
              </li>
            )
          })}
        </ul>
        <DialogFooter>
          <Button onClick={onDismissed}>{t("common.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
