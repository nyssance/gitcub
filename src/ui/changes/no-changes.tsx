// Desktop MIT port; platform imports adapted to Tauri.
import memoizeOne from "memoize-one"
import * as React from "react"
import { Trans, useTranslation } from "react-i18next"

import { formatNumber } from "../../lib/format-number"
import { getPlatformSpecificNameOrSymbolForModifier } from "../../lib/menu/menu-item"
import {
  type NoChangesRepositoryState,
  type PrimarySuggestion,
  primarySuggestion
} from "../../lib/no-changes-suggestions"
import { __DARWIN__, __LINUX__, __WIN32__ } from "../../lib/platform-flags"
import type { IMenu, MenuItem } from "../../models/app-menu"
import { LinkButton } from "../desktop/link-button"
import { Ref } from "../desktop/ref"
import { KeyboardShortcut } from "../keyboard-shortcut/keyboard-shortcut"
import { MenuBackedSuggestedAction } from "../suggested-actions/menu-backed-suggested-action"
import { SuggestedActionGroup } from "../suggested-actions/suggested-action-group"

function formatMenuItemLabel(text: string) {
  if (__WIN32__ || __LINUX__) {
    // Ampersand has a special meaning on Windows where it denotes
    // the access key (usually rendered as an underline on the following)
    // character. A literal ampersand is escaped by putting another ampersand
    // in front of it (&&). Here we strip single ampersands and unescape
    // double ampersands. Example: "&Push && Pull" becomes "Push & Pull".
    return text.replaceAll(/&?&/g, m => (m.length > 1 ? "&" : ""))
  }

  return text
}

function formatParentMenuLabel(menuItem: IMenuItemInfo) {
  const parentMenusText = menuItem.parentMenuLabels.join(" -> ")
  return formatMenuItemLabel(parentMenusText)
}

/** 同 Desktop static/paper-stack.svg；ci-check-run-no-steps 已经用的是这份 */
const PaperStackImage = "/desktop/paper-stack.svg"

type Translate = (key: string, options?: Record<string, unknown>) => string

interface INoChangesProps {
  /**
   * The currently selected repository: hosted on GitHub / GitLab or not,
   * and which platform wording to use.
   */
  readonly repository: { readonly isHosted: boolean; readonly platform: "github" | "gitlab" }

  /**
   * The top-level application menu item.
   */
  readonly appMenu: IMenu | undefined

  /**
   * An object describing the current state of
   * the selected repository. Used to determine
   * whether to render push, pull, publish, or
   * 'open pr' actions.
   */
  readonly repositoryState: NoChangesRepositoryState

  /**
   * Whether or not the user has a configured (explicitly,
   * or automatically) external editor. Used to
   * determine whether or not to render the action for
   * opening the repository in an external editor.
   */
  readonly isExternalEditorAvailable: boolean

  /** 「在设置里选编辑器」链接：打开设置的集成页 */
  readonly onOpenIntegrationPreferences: () => void

  readonly t: Translate
}

/**
 * Helper projection interface used to hold
 * computed information about a particular menu item.
 * Used internally in the NoChanges component to
 * trace whether a menu item is enabled, what its
 * keyboard shortcut is and so forth.
 */
interface IMenuItemInfo {
  /**
   * The textual representation of the menu item,
   * this is what's shown in the application menu
   */
  readonly label: string

  /**
   * Any accelerator keys (i.e. keyboard shortcut)
   * for the menu item. A menu item which can be
   * triggered using Command+Shift+K would be
   * represented here as three elements in the
   * array. Used to format and display the keyboard
   * shortcut for activating an action.
   */
  readonly acceleratorKeys: ReadonlyArray<string>

  /**
   * An ordered list of the labels for parent menus
   * of a particular menu item. Used to provide
   * a textual representation of where to locate
   * a particular action in the menu system.
   */
  readonly parentMenuLabels: ReadonlyArray<string>

  /**
   * Whether or not the menu item is currently
   * enabled.
   */
  readonly enabled: boolean
}

interface INoChangesState {
  /**
   * Whether or not to enable the slide in and
   * slide out transitions for the remote actions.
   *
   * Disabled initially and enabled 500ms after
   * component mounting in order to provide instant
   * loading of the remote action when the view is
   * initially appearing.
   */
  readonly enableTransitions: boolean
}

function getItemAcceleratorKeys(item: MenuItem) {
  if (item.type === "separator" || item.type === "submenuItem") {
    return []
  }

  if (item.accelerator === null) {
    return []
  }

  return item.accelerator.split("+").map(getPlatformSpecificNameOrSymbolForModifier)
}

function buildMenuItemInfoMap(
  menu: IMenu,
  map = new Map<string, IMenuItemInfo>(),
  parent?: IMenuItemInfo
): ReadonlyMap<string, IMenuItemInfo> {
  for (const item of menu.items) {
    if (item.type === "separator") {
      continue
    }

    const infoItem: IMenuItemInfo = {
      label: item.label,
      acceleratorKeys: getItemAcceleratorKeys(item),
      parentMenuLabels: parent === undefined ? [] : [parent.label, ...parent.parentMenuLabels],
      enabled: item.enabled
    }

    map.set(item.id, infoItem)

    if (item.type === "submenuItem") {
      buildMenuItemInfoMap(item.menu, map, infoItem)
    }
  }

  return map
}

/** The component to display when there are no local changes. */
class NoChangesView extends React.Component<INoChangesProps, INoChangesState> {
  private getMenuInfoMap = memoizeOne((menu: IMenu | undefined) =>
    menu === undefined ? new Map<string, IMenuItemInfo>() : buildMenuItemInfoMap(menu)
  )

  /**
   * ID for the timer that's activated when the component
   * mounts. See componentDidMount/componentWillUnmount.
   */
  private transitionTimer: number | null = null

  public constructor(props: INoChangesProps) {
    super(props)
    this.state = {
      enableTransitions: false
    }
  }

  private getMenuItemInfo(menuItemId: string): IMenuItemInfo | undefined {
    return this.getMenuInfoMap(this.props.appMenu).get(menuItemId)
  }

  private getPlatformFileManagerName() {
    const { t } = this.props
    if (__DARWIN__) {
      return t("noChanges.fileManager.finder")
    } else if (__WIN32__) {
      return t("noChanges.fileManager.explorer")
    }
    return t("noChanges.fileManager.generic")
  }

  /** GitHub / GitLab 的措辞跟仓库所在平台走，和原生菜单一致 */
  private platformName() {
    return this.props.repository.platform === "gitlab" ? "GitLab" : "GitHub"
  }

  private renderDiscoverabilityElements(menuItem: IMenuItemInfo) {
    const parentMenusText = formatParentMenuLabel(menuItem)

    return (
      <>
        {this.props.t("noChanges.discoverMenu", { menu: parentMenusText })}{" "}
        {this.renderDiscoverabilityKeyboardShortcut(menuItem)}
      </>
    )
  }

  private renderDiscoverabilityKeyboardShortcut(menuItemInfo: IMenuItemInfo) {
    return <KeyboardShortcut darwinKeys={menuItemInfo.acceleratorKeys} keys={menuItemInfo.acceleratorKeys} />
  }

  private renderMenuBackedAction(
    itemId: string,
    title: string,
    description?: string | React.JSX.Element,
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  ) {
    const menuItem = this.getMenuItemInfo(itemId)

    if (menuItem === undefined) {
      log.error(`Could not find matching menu item for ${itemId}`)
      return null
    }

    return (
      <MenuBackedSuggestedAction
        title={title}
        description={description}
        discoverabilityContent={this.renderDiscoverabilityElements(menuItem)}
        menuItemId={itemId}
        buttonText={formatMenuItemLabel(menuItem.label)}
        disabled={!menuItem.enabled}
        onClick={onClick}
      />
    )
  }

  private renderShowInFileManager() {
    const fileManager = this.getPlatformFileManagerName()

    return this.renderMenuBackedAction(
      "open-working-directory",
      this.props.t("noChanges.showInFileManager", { fileManager })
    )
  }

  private renderViewOnGitHub() {
    if (!this.props.repository.isHosted) {
      return null
    }

    return this.renderMenuBackedAction(
      "view-repository-on-github",
      this.props.t("noChanges.viewOnGitHub", { platform: this.platformName() })
    )
  }

  private openIntegrationPreferences = () => {
    this.props.onOpenIntegrationPreferences()
  }

  private renderOpenInExternalEditor() {
    if (!this.props.isExternalEditorAvailable) {
      return null
    }

    const itemId = "open-external-editor"
    const menuItem = this.getMenuItemInfo(itemId)

    if (menuItem === undefined) {
      log.error(`Could not find matching menu item for ${itemId}`)
      return null
    }

    const preferencesMenuItem = this.getMenuItemInfo("preferences")

    if (preferencesMenuItem === undefined) {
      log.error(`Could not find matching menu item for ${itemId}`)
      return null
    }

    const { t } = this.props
    const title = t("noChanges.openInEditor")

    const description = (
      <>
        {t("noChanges.openInEditorDescription")}{" "}
        <LinkButton onClick={this.openIntegrationPreferences}>
          {__DARWIN__ ? t("noChanges.settings") : t("noChanges.options")}
        </LinkButton>
      </>
    )

    return this.renderMenuBackedAction(itemId, title, description)
  }

  private renderRemoteAction(suggestion: PrimarySuggestion | null) {
    const { remote, aheadBehind, branch, tagsToPush } = this.props.repositoryState

    switch (suggestion) {
      case "publish-repository":
        return this.renderPublishRepositoryAction()
      case "publish-branch":
        return branch === null ? null : this.renderPublishBranchAction(branch)
      case "pull":
        return branch === null || remote === null || aheadBehind === null
          ? null
          : this.renderPullBranchAction(branch, remote, aheadBehind)
      case "push":
        return branch === null || remote === null || aheadBehind === null
          ? null
          : this.renderPushBranchAction(branch, remote, aheadBehind, tagsToPush)
      case "create-pull-request":
        return branch === null ? null : this.renderCreatePullRequestAction(branch)
      default:
        return null
    }
  }

  private renderViewStashAction() {
    const { t } = this.props
    const { stashEntry } = this.props.repositoryState
    if (stashEntry === null) {
      return null
    }

    // Desktop 还会写出贮藏里的文件数（stashEntry.files）；本项目的贮藏条目不带文件列表，省掉数字
    const description = <>{t("noChanges.viewStashDescription")}</>
    const discoverabilityContent = <>{t("noChanges.viewStashDiscover")}</>
    const itemId = "toggle-stashed-changes"
    const menuItem = this.getMenuItemInfo(itemId)
    if (menuItem === undefined) {
      log.error(`Could not find matching menu item for ${itemId}`)
      return null
    }

    return (
      <MenuBackedSuggestedAction
        key="view-stash-action"
        title={t("noChanges.viewStash")}
        menuItemId={itemId}
        description={description}
        discoverabilityContent={discoverabilityContent}
        buttonText={t("noChanges.viewStashButton")}
        type="primary"
        disabled={!menuItem.enabled}
      />
    )
  }

  private renderPublishRepositoryAction() {
    // This is a bit confusing, there's no dedicated
    // publish menu item, the 'Push' menu item will initiate
    // a publish if the repository doesn't have a remote. We'll
    // use it here for the keyboard shortcut only.
    const itemId = "push"
    const menuItem = this.getMenuItemInfo(itemId)

    if (menuItem === undefined) {
      log.error(`Could not find matching menu item for ${itemId}`)
      return null
    }

    const { t } = this.props
    const discoverabilityContent = (
      <>
        {t("noChanges.publishRepositoryDiscover")} {this.renderDiscoverabilityKeyboardShortcut(menuItem)}
      </>
    )

    return (
      <MenuBackedSuggestedAction
        key="publish-repository-action"
        title={t("noChanges.publishRepository", { platform: this.platformName() })}
        description={t("noChanges.publishRepositoryDescription", { platform: this.platformName() })}
        discoverabilityContent={discoverabilityContent}
        buttonText={t("noChanges.publishRepositoryButton")}
        menuItemId={itemId}
        type="primary"
        disabled={!menuItem.enabled}
      />
    )
  }

  private renderPublishBranchAction(branch: string) {
    // This is a bit confusing, there's no dedicated
    // publish branch menu item, the 'Push' menu item will initiate
    // a publish if the branch doesn't have a remote tracking branch.
    // We'll use it here for the keyboard shortcut only.
    const itemId = "push"
    const menuItem = this.getMenuItemInfo(itemId)

    if (menuItem === undefined) {
      log.error(`Could not find matching menu item for ${itemId}`)
      return null
    }

    const { t } = this.props
    const isHosted = this.props.repository.isHosted

    const description = (
      <Trans
        i18nKey={isHosted ? "noChanges.publishBranchDescriptionHosted" : "noChanges.publishBranchDescription"}
        values={{ branch, platform: this.platformName() }}
        components={{ ref: <Ref /> }}
      />
    )

    const discoverabilityContent = (
      <>
        {t("noChanges.publishBranchDiscover")} {this.renderDiscoverabilityKeyboardShortcut(menuItem)}
      </>
    )

    return (
      <MenuBackedSuggestedAction
        key="publish-branch-action"
        title={t("noChanges.publishBranch")}
        menuItemId={itemId}
        description={description}
        discoverabilityContent={discoverabilityContent}
        buttonText={t("noChanges.publishBranchButton")}
        type="primary"
        disabled={!menuItem.enabled}
      />
    )
  }

  private renderPullBranchAction(branch: string, remote: string, aheadBehind: { behind: number }) {
    const itemId = "pull"
    const menuItem = this.getMenuItemInfo(itemId)

    if (menuItem === undefined) {
      log.error(`Could not find matching menu item for ${itemId}`)
      return null
    }

    const { t } = this.props
    const isHosted = this.props.repository.isHosted

    const description = (
      <Trans
        i18nKey="noChanges.pullDescription"
        count={aheadBehind.behind}
        values={{ branch, where: isHosted ? this.platformName() : t("noChanges.theRemote") }}
        components={{ ref: <Ref /> }}
      />
    )

    const discoverabilityContent = (
      <>
        {t("noChanges.pullDiscover")} {this.renderDiscoverabilityKeyboardShortcut(menuItem)}
      </>
    )

    const title = t("noChanges.pull", {
      count: aheadBehind.behind,
      commits: formatNumber(aheadBehind.behind),
      remote
    })

    const buttonText = t("noChanges.pullButton", { remote })

    return (
      <MenuBackedSuggestedAction
        key="pull-branch-action"
        title={title}
        menuItemId={itemId}
        description={description}
        discoverabilityContent={discoverabilityContent}
        buttonText={buttonText}
        type="primary"
        disabled={!menuItem.enabled}
      />
    )
  }

  private renderPushBranchAction(
    branch: string,
    remote: string,
    aheadBehind: { ahead: number },
    tagsToPush: ReadonlyArray<string> | null
  ) {
    const itemId = "push"
    const menuItem = this.getMenuItemInfo(itemId)

    if (menuItem === undefined) {
      log.error(`Could not find matching menu item for ${itemId}`)
      return null
    }

    const { t } = this.props
    const isHosted = this.props.repository.isHosted

    const itemsToPushTypes = []
    const itemsToPushDescriptions = []

    if (aheadBehind.ahead > 0) {
      itemsToPushTypes.push(t("noChanges.pushTypeCommits"))
      itemsToPushDescriptions.push(
        t("noChanges.pushLocalCommits", { count: aheadBehind.ahead, commits: formatNumber(aheadBehind.ahead) })
      )
    }

    if (tagsToPush !== null && tagsToPush.length > 0) {
      itemsToPushTypes.push(t("noChanges.pushTypeTags"))
      itemsToPushDescriptions.push(
        t("noChanges.pushTags", { count: tagsToPush.length, tags: formatNumber(tagsToPush.length) })
      )
    }

    const description = t("noChanges.pushDescription", {
      items: itemsToPushDescriptions.join(t("noChanges.and")),
      where: isHosted ? this.platformName() : t("noChanges.theRemote")
    })

    const discoverabilityContent = (
      <>
        {t("noChanges.pushDiscover")} {this.renderDiscoverabilityKeyboardShortcut(menuItem)}
      </>
    )

    const title = t("noChanges.push", { items: itemsToPushTypes.join(t("noChanges.and")), remote })

    const buttonText = t("noChanges.pushButton", { remote })

    return (
      <MenuBackedSuggestedAction
        key="push-branch-action"
        title={title}
        menuItemId={itemId}
        description={description}
        discoverabilityContent={discoverabilityContent}
        buttonText={buttonText}
        type="primary"
        disabled={!menuItem.enabled}
      />
    )
  }

  /** Desktop 在这里是「预览 / 创建 PR」下拉（DropdownSuggestedAction）；本项目两项都打开同一个创建流程，
   *  只给创建一项 */
  private renderCreatePullRequestAction(branch: string) {
    const createMenuItem = this.getMenuItemInfo("create-pull-request")
    if (createMenuItem === undefined) {
      log.error(`Could not find matching menu item for 'create-pull-request'`)
      return null
    }

    const { t } = this.props
    const gitlab = this.props.repository.platform === "gitlab"
    const description = (
      <Trans
        i18nKey={gitlab ? "noChanges.createMergeRequestDescription" : "noChanges.createPullRequestDescription"}
        values={{ branch }}
        components={{ ref: <Ref /> }}
      />
    )

    return (
      <MenuBackedSuggestedAction
        key="pull-request-action"
        title={t(gitlab ? "noChanges.createMergeRequest" : "noChanges.createPullRequest")}
        menuItemId="create-pull-request"
        description={description}
        discoverabilityContent={this.renderDiscoverabilityElements(createMenuItem)}
        buttonText={formatMenuItemLabel(createMenuItem.label)}
        type="primary"
        disabled={!createMenuItem.enabled}
      />
    )
  }

  private renderActions() {
    const suggestion = primarySuggestion(this.props.repositoryState)
    return (
      <>
        <SuggestedActionGroup type="primary" transitions={"replace"} enableTransitions={this.state.enableTransitions}>
          {suggestion === "view-stash" ? this.renderViewStashAction() : this.renderRemoteAction(suggestion)}
        </SuggestedActionGroup>
        <SuggestedActionGroup>
          {this.renderOpenInExternalEditor()}
          {this.renderShowInFileManager()}
          {this.renderViewOnGitHub()}
        </SuggestedActionGroup>
      </>
    )
  }

  public componentDidMount() {
    this.transitionTimer = window.setTimeout(() => {
      this.setState({ enableTransitions: true })
      this.transitionTimer = null
    }, 500)
  }

  public componentWillUnmount() {
    if (this.transitionTimer !== null) {
      clearTimeout(this.transitionTimer)
    }
  }

  public render() {
    const { t } = this.props
    return (
      <div className="changes-interstitial">
        <div className="content">
          <div className="interstitial-header">
            <div className="text">
              <h1>{t("changes.noChanges")}</h1>
              <p>{t("noChanges.blurb")}</p>
            </div>
            <img src={PaperStackImage} className="blankslate-image" alt="" />
          </div>
          {this.renderActions()}
        </div>
      </div>
    )
  }
}

/** 没有本地改动时内容区的空白页（Desktop changes/no-changes.tsx），文案走 i18n */
export function NoChanges(props: Omit<INoChangesProps, "t">) {
  const { t } = useTranslation()
  return <NoChangesView {...props} t={(key, options) => t(key, options)} />
}
