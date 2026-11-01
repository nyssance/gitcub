// Desktop MIT port of ui/changes/undo-commit.tsx; written as a function component.
import { useTranslation } from "react-i18next"

import type { CommitInfo } from "@/models/history"
import type { Emoji } from "@/upstream/lib/emoji"

import { Button } from "../desktop/button"
import { RichText } from "../desktop/rich-text"
import { RelativeTime } from "../relative-time"

interface IUndoCommitProps {
  /** The function to call when the Undo button is clicked. */
  readonly onUndo: () => void

  /** The commit to undo. */
  readonly commit: CommitInfo

  /** The emoji cache to use when rendering the commit message */
  readonly emoji: Map<string, Emoji>

  /** whether a push, pull or fetch is in progress */
  readonly isPushPullFetchInProgress: boolean

  /** whether a committing is in progress */
  readonly isCommitting: boolean
}

/** The Undo Commit component. */
export function UndoCommit({ onUndo, commit, emoji, isPushPullFetchInProgress, isCommitting }: IUndoCommitProps) {
  const { t } = useTranslation()
  const disabled = isPushPullFetchInProgress || isCommitting
  const title = disabled ? t("undoCommit.undoIsDisabledWhileTheRepositoryIsBeingUpdated") : undefined

  const authorDate = new Date(commit.time * 1000)
  return (
    <div id="undo-commit" role="group" aria-label={t("undoCommit.undoCommit")}>
      <div className="commit-info">
        <div className="ago">
          {t("undoCommit.committed")} <RelativeTime date={authorDate} />
        </div>
        <RichText emoji={emoji} className="summary" text={commit.summary} renderUrlsAsLinks={false} />
      </div>
      <div className="actions">
        <Button size="small" disabled={disabled} onClick={onUndo} tooltip={title}>
          {t("undoCommit.undo")}
        </Button>
      </div>
    </div>
  )
}
