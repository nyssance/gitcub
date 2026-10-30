// Desktop MIT port; platform imports adapted to Tauri.
/**
 * This a11y linter is a false-positive as the element is a drop target
 * facilitating our drag and drop functionality for reordering, squashing, and
 * cherry-picking.
 */

import classNames from "classnames"
import * as React from "react"

import { enableAccessibleListToolTips } from "../../lib/desktop-features"
import { dragAndDropManager } from "../../lib/drag-and-drop-manager"
import { formatDate } from "../../lib/format-date"
import type { Account } from "../../models/account"
import { getAvatarUsersForCommit, type IAvatarUser } from "../../models/avatar"
import type { Commit } from "../../models/commit"
import { DragType, DropTargetSelector, DropTargetType } from "../../models/drag-drop"
import type { GitHubRepository } from "../../models/github-repository"
import type { Emoji } from "../../upstream/lib/emoji"
import { CommitAttribution } from "../changes/commit-attribution"
import { AvatarStack } from "../desktop/avatar-stack"
import { Draggable } from "../desktop/draggable"
import { RichText } from "../desktop/rich-text"
import { TooltippedContent } from "../desktop/tooltipped-content"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"
import { RelativeTime } from "../relative-time"

interface ICommitProps {
  readonly gitHubRepository: GitHubRepository | null
  readonly commit: Commit
  readonly selectedCommits: ReadonlyArray<Commit>
  readonly emoji: Map<string, Emoji>
  readonly onRenderCommitDragElement?: (commit: Commit) => void
  readonly onRemoveDragElement?: () => void
  readonly onSquash?: (toSquash: ReadonlyArray<Commit>, squashOnto: Commit, isInvokedByContextMenu: boolean) => void
  /**
   * Whether or not the commit can be dragged for certain operations like squash,
   * cherry-pick, reorder, etc. Defaults to false.
   */
  readonly isDraggable?: boolean
  readonly showUnpushedIndicator: boolean
  readonly disableSquashing?: boolean
  readonly unpushedIndicatorTitle?: string
  readonly accounts: ReadonlyArray<Account>
  readonly preferAbsoluteDates: boolean
}

interface ICommitListItemState {
  readonly avatarUsers: ReadonlyArray<IAvatarUser>
}

/** A component which displays a single commit in a commit list. */
export class CommitListItem extends React.PureComponent<ICommitProps, ICommitListItemState> {
  public constructor(props: ICommitProps) {
    super(props)

    this.state = {
      avatarUsers: getAvatarUsersForCommit(props.gitHubRepository, props.commit)
    }
  }

  public componentWillReceiveProps(nextProps: ICommitProps) {
    if (nextProps.commit !== this.props.commit) {
      this.setState({
        avatarUsers: getAvatarUsersForCommit(nextProps.gitHubRepository, nextProps.commit)
      })
    }
  }

  private onMouseUp = () => {
    const { onSquash, selectedCommits, commit, disableSquashing } = this.props
    if (
      disableSquashing !== true &&
      dragAndDropManager.isDragOfTypeInProgress(DragType.Commit) &&
      onSquash !== undefined &&
      // don't squash if dragging one commit and dropping onto itself
      selectedCommits.some(c => c.sha !== commit.sha)
    ) {
      onSquash(selectedCommits, commit, false)
    }
  }

  private onMouseEnter = () => {
    const { selectedCommits, commit, disableSquashing } = this.props
    const isSelected = selectedCommits.some(c => c.sha === commit.sha)
    if (disableSquashing !== true && dragAndDropManager.isDragOfTypeInProgress(DragType.Commit) && !isSelected) {
      dragAndDropManager.emitEnterDropTarget({
        type: DropTargetType.Commit
      })
    }
  }

  private onMouseLeave = () => {
    if (dragAndDropManager.isDragOfTypeInProgress(DragType.Commit)) {
      dragAndDropManager.emitLeaveDropTarget()
    }
  }

  public render() {
    const { commit } = this.props
    const {
      author: { date }
    } = commit

    const isDraggable = this.props.isDraggable || false
    const hasEmptySummary = commit.summary.length === 0
    const commitSummary = hasEmptySummary ? "Empty commit message" : commit.summary

    const summaryClassNames = classNames("summary", {
      "empty-summary": hasEmptySummary
    })

    return (
      <Draggable
        isEnabled={isDraggable}
        onDragStart={this.onDragStart}
        onRenderDragElement={this.onRenderCommitDragElement}
        onRemoveDragElement={this.onRemoveDragElement}
        dropTargetSelectors={[
          DropTargetSelector.Branch,
          DropTargetSelector.PullRequest,
          DropTargetSelector.Commit,
          DropTargetSelector.ListInsertionPoint
        ]}>
        <div
          className="commit"
          onMouseEnter={this.onMouseEnter}
          onMouseLeave={this.onMouseLeave}
          onMouseUp={this.onMouseUp}>
          <div className="info">
            <RichText
              className={summaryClassNames}
              emoji={this.props.emoji}
              text={commitSummary}
              renderUrlsAsLinks={false}
            />
            <div className="description">
              <AvatarStack
                users={this.state.avatarUsers}
                accounts={this.props.accounts}
                tooltip={!enableAccessibleListToolTips()}
              />
              <div className="byline">
                <CommitAttribution avatarUsers={this.state.avatarUsers} />
                {renderRelativeTime(date, this.props.preferAbsoluteDates)}
              </div>
            </div>
          </div>
          {this.renderCommitIndicators()}
        </div>
      </Draggable>
    )
  }

  private renderCommitIndicators() {
    const tagIndicator = renderCommitListItemTags(this.props.commit.tags)
    const unpushedIndicator = this.renderUnpushedIndicator()

    if (tagIndicator || unpushedIndicator) {
      return (
        <div className="commit-indicators">
          {tagIndicator}
          {unpushedIndicator}
        </div>
      )
    }

    return null
  }

  private renderUnpushedIndicator() {
    if (!this.props.showUnpushedIndicator) {
      return null
    }

    return (
      <TooltippedContent
        tagName="div"
        className="unpushed-indicator"
        tooltip={this.props.unpushedIndicatorTitle}
        disabled={enableAccessibleListToolTips()}>
        <Octicon symbol={octicons.arrowUp} />
      </TooltippedContent>
    )
  }

  private onDragStart = () => {
    // Removes active status from commit selection so they do not appear
    // highlighted in commit list.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    dragAndDropManager.setDragData({
      type: DragType.Commit,
      commits: this.props.selectedCommits
    })
  }

  private onRenderCommitDragElement = () => {
    if (this.props.onRenderCommitDragElement !== undefined) {
      this.props.onRenderCommitDragElement(this.props.commit)
    }
  }

  private onRemoveDragElement = () => {
    if (this.props.onRemoveDragElement !== undefined) {
      this.props.onRemoveDragElement()
    }
  }
}

function renderRelativeTime(date: Date, preferAbsoluteDates: boolean) {
  return (
    <>
      {` • `}
      {preferAbsoluteDates ? formatDate(date) : <RelativeTime date={date} tooltip={!enableAccessibleListToolTips()} />}
    </>
  )
}

function renderCommitListItemTags(tags: ReadonlyArray<string>) {
  if (tags.length === 0) {
    return null
  }
  const [firstTag] = tags
  return (
    <span className="tag-indicator">
      <span className="tag-name" key={firstTag}>
        {firstTag}
      </span>
      {tags.length > 1 && <span key={tags.length} className="tag-indicator-more" />}
    </span>
  )
}
