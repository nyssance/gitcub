// Desktop MIT port: app/src/ui/toolbar/push-pull-button.tsx and push-pull-button-dropdown.tsx.
// Function component; the toolbar button, MultiOption dropdown and foldout use the shadcn Button/Popover.
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import type { NetworkProgress } from "@/features/repository/store"
import { ForcePushBranchState } from "@/lib/force-push-state"
import { formatCompactNumber } from "@/lib/format-number"
import { cn } from "@/lib/utils"
import { AriaLiveContainer } from "@/ui/accessibility/aria-live-container"
import { Button } from "@/ui/base/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/base/popover"
import { Octicon, type OcticonSymbol, type OcticonSymbolVariant, syncClockwise } from "@/ui/octicons"
import * as octicons from "@/ui/octicons/octicons.generated"
import { RelativeTime } from "@/ui/relative-time"

export const DropdownItemClassName = "push-pull-dropdown-item"

/** Desktop TipState 中推拉按钮区分的三种 */
export type PushPullTipState = "valid" | "unborn" | "detached"

interface Props {
  /** The ahead/behind count for the current branch. If null, it indicates the branch doesn't have an upstream. */
  aheadBehind: { ahead: number; behind: number } | null
  /** The name of the remote. */
  remoteName: string | null
  /** Is a push/pull/fetch in progress? */
  networkActionInProgress: boolean
  /** The date of the last fetch. */
  lastFetched: Date | null
  /** Progress information associated with the current operation */
  progress: NetworkProgress | null
  /** Indicate whether the current branch is valid, unborn or detached HEAD */
  tipState: PushPullTipState
  /** Has the user configured pull.rebase to anything? */
  pullWithRebase?: boolean
  /** Is the detached HEAD state related to a rebase or not? */
  rebaseInProgress: boolean
  /** Force push state of the current branch */
  forcePushBranchState: ForcePushBranchState
  /** The number of tags that would get pushed if the user performed a push. */
  numTagsToPush: number
  /** Will the app prompt the user to confirm a force push? */
  askForConfirmationOnForcePush: boolean
  /** Desktop repository.gitHubRepository：远端在哪个托管平台上（GitLab 一等支持），不是托管仓库为 null */
  hostedPlatform: "GitHub" | "GitLab" | null
  /** 没有选中仓库，或别的写操作正占着操作锁 */
  disabled: boolean
  onPush: () => void
  onPull: () => void
  onFetch: () => void
  onForcePush: () => void
}

type ActionInProgress = "push" | "pull" | "fetch" | "force push"

export enum DropdownItemType {
  Fetch = "fetch",
  ForcePush = "force-push"
}

export type DropdownItem = {
  readonly title: string
  readonly description: ReactNode
  readonly action: () => void
  readonly icon: OcticonSymbol
}

function renderAheadBehind(aheadBehind: { ahead: number; behind: number }, numTagsToPush: number) {
  const { ahead, behind } = aheadBehind
  if (ahead === 0 && behind === 0 && numTagsToPush === 0) {
    return null
  }

  const content = new Array<ReactNode>()
  if (ahead > 0 || numTagsToPush > 0) {
    content.push(
      <span key="ahead" className="flex items-center">
        {formatCompactNumber(ahead + numTagsToPush)}
        <Octicon symbol={octicons.arrowUp} className="ml-[3px] w-2.5" />
      </span>
    )
  }

  if (behind > 0) {
    content.push(
      <span key="behind" className="flex items-center nth-2:ml-[5px]">
        {formatCompactNumber(behind)}
        <Octicon symbol={octicons.arrowDown} className="ml-[3px] w-2.5" />
      </span>
    )
  }

  return (
    <div className="ahead-behind bg-toolbar-badge mr-2.5 flex h-[13px] shrink-0 rounded-lg px-1.5 text-[10px] leading-[13px] font-semibold">
      {content}
    </div>
  )
}

function LastFetched({ lastFetched }: { lastFetched: Date | null }) {
  if (lastFetched) {
    return (
      <span>
        <Trans i18nKey="toolbar.lastFetched" components={[<RelativeTime key="time" date={lastFetched} />]} />
      </span>
    )
  }
  return <Trans i18nKey="toolbar.neverFetched" />
}

/**
 * This represents the "double arrow" icon used to show a force-push, and is a
 * less complicated icon than the generated Octicon from the `octicons` package.
 */
export const forcePushIcon: OcticonSymbolVariant = {
  w: 10,
  h: 16,
  p: [
    "M0 6a.75.75 0 0 0 .974.714L4.469 3.22a.75.75 0 0 1 1.06 0l3.478 3.478a.75.75 " +
      "0 0 0 .772-1.228L5.53 1.22a.75.75 0 0 0-1.06 0L.22 5.47A.75.75 0 0 0 0 6zm0 " +
      "3a.75.75 0 0 0 1.28.53l2.97-2.97V14a.75.75 0 1 0 1.5 0V6.56l2.97 2.97a.75.75 " +
      "0 0 0 1.06-1.06L5.53 4.22a.75.75 0 0 0-1.06 0L.22 8.47A.75.75 0 0 0 0 9z"
  ]
}

const buttonClassName = cn(
  "push-pull-button border-toolbar-border relative h-full min-w-0 justify-start gap-0 overflow-hidden rounded-none border-0 border-r px-2.5 text-left",
  "text-toolbar-foreground hover:bg-toolbar-hover hover:text-toolbar-foreground disabled:opacity-60"
)

/** Desktop ToolbarButton，ToolbarButtonStyle.Subtitle：粗体标题在上，说明小字在下 */
function ToolbarButton(props: {
  title: string
  description: ReactNode
  icon: OcticonSymbol
  iconClassName?: string
  tooltip?: string
  progressValue?: number
  disabled?: boolean
  onClick?: () => void
  className?: string
  children?: ReactNode
}) {
  const hasProgress = props.progressValue !== undefined
  return (
    <Button
      variant="ghost"
      type="button"
      title={props.tooltip}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(buttonClassName, hasProgress && "disabled:opacity-100", props.className)}>
      {hasProgress && (
        <div
          className="progress bg-toolbar-progress pointer-events-none absolute inset-0 origin-left transition-transform duration-300"
          style={{ transform: `scaleX(${props.progressValue})` }}
        />
      )}
      <Octicon symbol={props.icon} className={cn("relative mr-2.5 shrink-0", props.iconClassName)} />
      <div className="text relative mr-2.5 flex min-w-0 grow flex-col">
        <div className="title truncate text-xs font-semibold">{props.title}</div>
        <div className="description text-toolbar-muted truncate text-[11px] font-normal">{props.description}</div>
      </div>
      {props.children}
    </Button>
  )
}

/**
 * A button which pushes, pulls, or updates depending on the state of the
 * repository.
 */
export function PushPullButton(props: Props) {
  const { t } = useTranslation()
  const [screenReaderStateMessage, setScreenReaderStateMessage] = useState<string | null>(null)
  const [isDropdownOpen, setDropdownOpen] = useState(false)
  const actionInProgress = useRef<ActionInProgress | null>(null)
  const previousProgress = useRef<NetworkProgress | null>(null)
  const screenReaderElement = useRef<HTMLSpanElement>(null)
  const dropdown = useRef<HTMLDivElement>(null)

  // Desktop componentDidUpdate：进度开始或换标题时朗读进度，结束时朗读「… complete」
  const { progress } = props
  useEffect(() => {
    const previous = previousProgress.current
    previousProgress.current = progress
    const progressChanged = (progress !== null && previous == null) || progress?.title !== previous?.title
    const progressComplete = progress === null && previous !== null

    if (progressChanged && progress !== null) {
      const { description, title, kind } = progress
      setScreenReaderStateMessage(`${title} ${description ?? t("toolbar.hangOn")}`)
      // Desktop isPullPushFetchProgress：收尾的刷新进度不算动作
      if (kind !== "generic") actionInProgress.current ??= kind
    }

    if (progressComplete) {
      setScreenReaderStateMessage(
        t("toolbar.actionComplete", { action: actionInProgress.current ?? t("toolbar.pullPushOrFetch") })
      )
      actionInProgress.current = null
    }
  }, [progress, t])

  const closeDropdown = () => setDropdownOpen(false)

  const push = () => {
    closeDropdown()
    props.onPush()
  }

  /**
   * Desktop returnFocusOnDeactivate：强推要弹确认框时，焦点不回到下拉按钮（它会被换成别的按钮），
   * 而是放到朗读区，确认框关掉后读屏才能读出结果
   */
  const returnFocusOnDeactivate =
    props.forcePushBranchState === ForcePushBranchState.NotAvailable || !props.askForConfirmationOnForcePush

  /**
   * This is a hack to get the screen reader to read the message after the force
   * push confirm dialog closes: the dialog returns focus to the active element,
   * so make that an element containing the sr element before opening it.
   */
  const setScreenReaderStateMessageFocus = () => {
    const srElement = screenReaderElement.current
    if (srElement) {
      srElement.tabIndex = -1
      srElement.focus()
    }
  }

  const forcePushWithLease = () => {
    closeDropdown()

    setScreenReaderStateMessageFocus()
    props.onForcePush()

    actionInProgress.current = "force push"
  }

  const pull = () => {
    closeDropdown()
    props.onPull()
  }

  const fetch = () => {
    closeDropdown()
    props.onFetch()
  }

  const getDropdownItemWithType = (type: DropdownItemType): DropdownItem => {
    const { remoteName } = props
    switch (type) {
      case DropdownItemType.Fetch:
        return {
          title: t("toolbar.fetchRemote", { remote: remoteName }),
          description: t("toolbar.fetchTheLatestChangesFrom", { remote: remoteName }),
          action: fetch,
          icon: syncClockwise
        }
      case DropdownItemType.ForcePush: {
        const forcePushWarning = props.askForConfirmationOnForcePush ? null : (
          <div className="warning text-toolbar-warning mt-2.5">
            <Trans i18nKey="toolbar.forcePushWarning" components={[<span key="title" className="font-semibold" />]} />
          </div>
        )
        return {
          title: t("toolbar.forcePushRemote", { remote: remoteName }),
          description: (
            <>
              {t("toolbar.overwriteAnyChangesOn", { remote: remoteName })}
              {forcePushWarning}
            </>
          ),
          action: forcePushWithLease,
          icon: forcePushIcon
        }
      }
    }
  }

  // Desktop PushPullButtonDropDown onDropdownKeyDown：上下方向键在菜单项之间移动（同 Tab / Shift+Tab）
  const onDropdownKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return
    }

    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(`.${DropdownItemClassName}`)]
    const focusedItem = event.currentTarget.querySelector<HTMLElement>(":focus")
    if (!focusedItem) {
      return
    }
    const focusedIndex = items.indexOf(focusedItem)
    const nextIndex = event.key === "ArrowDown" ? focusedIndex + 1 : focusedIndex - 1
    items[(nextIndex + items.length) % items.length]?.focus()
  }

  const renderDropdownContent = (itemTypes: ReadonlyArray<DropdownItemType>) => (
    <div className="push-pull-dropdown mt-px flex max-w-full flex-col" onKeyDown={onDropdownKeyDown}>
      {itemTypes.map(type => {
        const item = getDropdownItemWithType(type)
        return (
          <Button
            key={type}
            variant="ghost"
            className={cn(
              DropdownItemClassName,
              "h-fit flex-row items-start justify-start gap-2.5 rounded-none p-2.5 text-left font-normal whitespace-normal",
              "not-last:border-border hover:bg-accent not-last:border-b"
            )}
            onClick={item.action}>
            <Octicon symbol={item.icon} className="size-4 shrink-0" />
            <div className="text-container flex flex-col gap-y-[3px]">
              <div className="title font-semibold">{item.title}</div>
              <div className="detail text-muted-foreground">{item.description}</div>
            </div>
          </Button>
        )
      })}
    </div>
  )

  /** Desktop ToolbarDropdown，ToolbarDropdownStyle.MultiOption：主按钮执行动作，右边 39px 的箭头按钮展开选项 */
  const renderDropdown = (button: {
    title: string
    description: ReactNode
    icon: OcticonSymbol
    onClick: () => void
    itemTypes: ReadonlyArray<DropdownItemType>
    children?: ReactNode
  }) => (
    <div ref={dropdown} className="toolbar-dropdown multi-option-style flex h-full w-full min-w-0 flex-row">
      <ToolbarButton
        title={button.title}
        description={button.description}
        icon={button.icon}
        disabled={props.disabled}
        onClick={button.onClick}
        className="grow">
        {button.children}
      </ToolbarButton>
      <Popover open={isDropdownOpen} onOpenChange={setDropdownOpen}>
        <PopoverTrigger
          aria-label={t("toolbar.pushPullFetchOptions")}
          render={
            <Button
              variant="ghost"
              type="button"
              disabled={props.disabled}
              className={cn(
                "toolbar-dropdown-arrow-button border-toolbar-border h-full w-[39px] shrink-0 rounded-none border-0 border-r p-0",
                "text-toolbar-foreground hover:bg-toolbar-hover hover:text-toolbar-foreground",
                isDropdownOpen && "bg-toolbar-hover"
              )}
            />
          }>
          <Octicon symbol={isDropdownOpen ? octicons.triangleUp : octicons.triangleDown} className="dropdownArrow" />
        </PopoverTrigger>
        <PopoverContent
          aria-label={t("toolbar.pushPullFetchOptions")}
          anchor={dropdown}
          side="bottom"
          align="start"
          sideOffset={0}
          finalFocus={returnFocusOnDeactivate ? true : screenReaderElement}
          // MultiOption：与整组按钮同宽，高度随内容
          style={{ width: "var(--anchor-width)" }}
          data-desktop-palette
          className="bg-background overflow-hidden rounded-none border-t-0 p-0">
          {renderDropdownContent(button.itemTypes)}
        </PopoverContent>
      </Popover>
    </div>
  )

  const progressButton = (progress: NetworkProgress, networkActionInProgress: boolean) => (
    <ToolbarButton
      title={progress.title}
      description={progress.description || t("toolbar.hangOn")}
      progressValue={progress.value}
      icon={syncClockwise}
      iconClassName={networkActionInProgress ? "animate-spin" : ""}
      tooltip={progress.description}
      disabled={true}
    />
  )

  const fetchButton = (remoteName: string, lastFetched: Date | null) => (
    <ToolbarButton
      title={t("toolbar.fetchRemote", { remote: remoteName })}
      description={<LastFetched lastFetched={lastFetched} />}
      icon={syncClockwise}
      disabled={props.disabled}
      onClick={fetch}
    />
  )

  const renderButton = () => {
    const {
      progress,
      networkActionInProgress,
      aheadBehind,
      numTagsToPush,
      remoteName,
      hostedPlatform,
      tipState,
      rebaseInProgress,
      lastFetched,
      pullWithRebase,
      forcePushBranchState
    } = props

    if (progress !== null) {
      return progressButton(progress, networkActionInProgress)
    }

    if (remoteName === null) {
      return (
        <ToolbarButton
          title={t("toolbar.publishRepository")}
          description={t("toolbar.publishThisRepositoryTo", { platform: hostedPlatform ?? "GitHub" })}
          icon={octicons.upload}
          disabled={props.disabled}
          onClick={push}
        />
      )
    }

    if (tipState === "unborn") {
      return fetchButton(remoteName, lastFetched)
    }

    if (tipState === "detached") {
      return (
        <ToolbarButton
          title={t("toolbar.publishBranch")}
          description={rebaseInProgress ? t("toolbar.rebaseInProgress") : t("toolbar.cannotPublishDetachedHead")}
          icon={octicons.upload}
          disabled={true}
        />
      )
    }

    if (aheadBehind === null) {
      return renderDropdown({
        title: t("toolbar.publishBranch"),
        description:
          hostedPlatform !== null
            ? t("toolbar.publishThisBranchTo", { platform: hostedPlatform })
            : t("toolbar.publishThisBranchToTheRemote"),
        icon: octicons.upload,
        onClick: push,
        itemTypes: [DropdownItemType.Fetch]
      })
    }

    const { ahead, behind } = aheadBehind

    if (ahead === 0 && behind === 0 && numTagsToPush === 0) {
      return fetchButton(remoteName, lastFetched)
    }

    if (forcePushBranchState === ForcePushBranchState.Recommended) {
      return renderDropdown({
        title: t("toolbar.forcePushRemote", { remote: remoteName }),
        description: <LastFetched lastFetched={lastFetched} />,
        icon: forcePushIcon,
        onClick: forcePushWithLease,
        itemTypes: [DropdownItemType.Fetch],
        children: renderAheadBehind(aheadBehind, numTagsToPush)
      })
    }

    if (behind > 0) {
      const dropdownItemTypes = [DropdownItemType.Fetch]

      if (forcePushBranchState !== ForcePushBranchState.NotAvailable) {
        dropdownItemTypes.push(DropdownItemType.ForcePush)
      }

      return renderDropdown({
        title: pullWithRebase
          ? t("toolbar.pullRemoteWithRebase", { remote: remoteName })
          : t("toolbar.pullRemote", { remote: remoteName }),
        description: <LastFetched lastFetched={lastFetched} />,
        icon: octicons.arrowDown,
        onClick: pull,
        itemTypes: dropdownItemTypes,
        children: renderAheadBehind(aheadBehind, numTagsToPush)
      })
    }

    return renderDropdown({
      title: t("toolbar.pushRemote", { remote: remoteName }),
      description: <LastFetched lastFetched={lastFetched} />,
      icon: octicons.arrowUp,
      onClick: push,
      itemTypes: [DropdownItemType.Fetch],
      children: renderAheadBehind(aheadBehind, numTagsToPush)
    })
  }

  return (
    <>
      {renderButton()}
      <span id="push-pull-button-state" ref={screenReaderElement}>
        <AriaLiveContainer message={screenReaderStateMessage} />
      </span>
    </>
  )
}
