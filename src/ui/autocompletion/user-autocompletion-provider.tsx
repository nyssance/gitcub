// Desktop MIT port; platform imports adapted to Tauri.

import memoizeOne from "memoize-one"
import type * as React from "react"

import type { IMentionableUser } from "../../lib/databases/index"
import { getStealthEmailForUser } from "../../lib/email"
import { isDotCom } from "../../lib/endpoint-capabilities"
import type { GitHubUserStore } from "../../lib/stores/github-user-store"
import type { Account } from "../../models/account"
import type { IAvatarUser } from "../../models/avatar"
import { copilotSweAgentBot } from "../../models/dot-com-bots"
import type { GitHubRepository } from "../../models/github-repository"
import { Avatar } from "../desktop/avatar"
import type { IAutocompletionProvider } from "./autocompletion-provider"

/** An autocompletion hit for a user. */
export type KnownUserHit = {
  readonly kind: "known-user"

  /** The username. */
  readonly username: string

  /**
   * The user's name or null if the user
   * hasn't entered a name in their profile
   */
  readonly name: string | null

  /**
   * The user's public email address. If the user
   * hasn't selected a public email address this
   * field will be an empty string.
   */
  readonly email: string

  readonly endpoint: string
}

export type UnknownUserHit = {
  readonly kind: "unknown-user"

  /** The username. */
  readonly username: string
}

export type UserHit = KnownUserHit | UnknownUserHit

/** 本项目差异：候选来自 Rust 侧按贡献目标取的列表（GitHub 与 GitLab 共用），不经 Desktop 的用户数据库；
 *  provider 只用到 GitHubUserStore 的这两个方法 */
export type MentionableUsersSource = Pick<GitHubUserStore, "getMentionableUsersMatching" | "getByLogin"> & {
  /** 没有 Desktop 账号（GitLab）时按平台接口解析用户名 */
  readonly getByLoginWithoutAccount?: (login: string) => Promise<IMentionableUser | null>
}

function userToHit(repository: GitHubRepository, user: IMentionableUser): UserHit {
  return {
    kind: "known-user",
    username: user.login,
    name: user.name,
    email: user.email,
    endpoint: repository.endpoint
  }
}

/** The autocompletion provider for user mentions in a GitHub repository. */
export class UserAutocompletionProvider implements IAutocompletionProvider<UserHit> {
  public readonly kind = "user"

  private readonly gitHubUserStore: MentionableUsersSource
  private readonly repository: GitHubRepository
  private readonly account: Account | null

  // We need to memoize this function so that we don't create a new array
  // on every render which would cause the Avatar component to re-render
  // unnecessarily
  private getAccountsFromAccount = memoizeOne((account: Account | null) => {
    return account ? [account] : []
  })

  public constructor(gitHubUserStore: MentionableUsersSource, repository: GitHubRepository, account?: Account) {
    this.gitHubUserStore = gitHubUserStore
    this.repository = repository
    this.account = account ?? null
  }

  public getRegExp(): RegExp {
    return /(?:^|\n| )(?:@)([a-z\d\\+-][a-z\d_-]*)?/g
  }

  protected async getUserAutocompletionItems(
    text: string,
    includeUnknownUser: boolean
  ): Promise<ReadonlyArray<UserHit>> {
    const users = await this.gitHubUserStore.getMentionableUsersMatching(this.repository, text)

    // dotcom doesn't let you autocomplete on your own handle
    const account = this.account
    const filtered = account ? users.filter(x => x.login !== account.login) : users

    const hits = filtered.map(x => userToHit(this.repository, x))

    if (includeUnknownUser && text.length > 0) {
      const exactMatch = hits.some(hit => hit.username.toLowerCase() === text.toLowerCase())

      if (!exactMatch) {
        hits.push({
          kind: "unknown-user",
          username: text
        })
      }
    }

    return hits
  }

  public async getAutocompletionItems(text: string): Promise<ReadonlyArray<UserHit>> {
    return this.getUserAutocompletionItems(text, false)
  }

  public renderItem(item: UserHit): React.JSX.Element {
    if (item.kind === "known-user" && this.account) {
      const user: IAvatarUser = {
        name: item.name ?? item.username,
        email: item.email,
        avatarURL: undefined,
        endpoint: item.endpoint
      }

      return (
        <div className="user" key={item.username}>
          <Avatar accounts={this.getAccountsFromAccount(this.account)} user={user} aria-hidden={true} />
          <span className="username">{item.username}</span>
          <span className="name">{item.name}</span>
        </div>
      )
    }

    return item.kind === "known-user" ? (
      <div className="user" key={item.username}>
        <span className="username">{item.username}</span>
        <span className="name">{item.name}</span>
      </div>
    ) : (
      <div className="user unknown" key={item.username}>
        <span className="username">{item.username}</span>
        <span className="description">Search for user</span>
      </div>
    )
  }

  public getCompletionText(item: UserHit): string {
    return `@${item.username}`
  }

  /**
   * Retrieve a user based on the user login name, i.e their handle.
   *
   * If the user is already cached no additional API requests
   * will be made. If the user isn't in the cache but found in
   * the API it will be persisted to the database and the
   * intermediate cache.
   *
   * @param login   The login (i.e. handle) of the user
   */
  public async exactMatch(login: string): Promise<UserHit | null> {
    if (this.account === null) {
      // 本项目差异：GitLab 账号不在 Desktop 账号库里，交给候选来源按平台接口解析；GitHub 没有账号时照原版返回 null
      const user = await this.gitHubUserStore.getByLoginWithoutAccount?.(login)
      return user ? userToHit(this.repository, user) : null
    }

    if (login.toLowerCase() === "copilot" && isDotCom(this.repository.endpoint)) {
      const { userId, login, endpoint } = copilotSweAgentBot
      return {
        kind: "known-user",
        username: login,
        name: login,
        email: getStealthEmailForUser(userId, login, endpoint),
        endpoint
      }
    }

    const user = await this.gitHubUserStore.getByLogin(this.account, login)

    if (!user) {
      return null
    }

    return userToHit(this.repository, user)
  }
}

export class CoAuthorAutocompletionProvider extends UserAutocompletionProvider {
  public getRegExp(): RegExp {
    return /(?:^|\n| )(?:@)?([a-z\d\\+-][a-z\d_-]*)?/g
  }

  public async getAutocompletionItems(text: string): Promise<ReadonlyArray<UserHit>> {
    return super.getUserAutocompletionItems(text, true)
  }
}
