// Desktop API repository contracts, unchanged.
import type { GitHubAccountType } from "./desktop-api-urls"
export interface IAPIRepository {
  readonly clone_url: string
  readonly ssh_url: string
  readonly html_url: string
  readonly name: string
  readonly owner: IAPIIdentity
  readonly private: boolean
  readonly fork: boolean
  readonly default_branch: string
  readonly pushed_at: string
  readonly has_issues: boolean
  readonly archived: boolean
}

/** Information needed to clone a repository. */
export interface IAPIRepositoryCloneInfo {
  /** Canonical clone URL of the repository. */
  readonly url: string

  /**
   * Default branch of the repository, if any. This is usually either retrieved
   * from the API for GitHub repositories, or undefined for other repositories.
   */
  readonly defaultBranch?: string
}

export interface IAPIFullRepository extends IAPIRepository {
  /**
   * The parent repository of a fork.
   *
   * HACK: BEWARE: This is defined as `parent: IAPIRepository | undefined`
   * rather than `parent?: ...` even though the parent property is actually
   * optional in the API response. So we're lying a bit to the type system
   * here saying that this will be present but the only time the difference
   * between omission and explicit undefined matters is when using constructs
   * like `x in y` or `y.hasOwnProperty('x')` which we do very rarely.
   *
   * Without at least one non-optional type in this interface TypeScript will
   * happily let us pass an IAPIRepository in place of an IAPIFullRepository.
   */
  readonly parent: IAPIRepository | undefined

  /**
   * The high-level permissions that the currently authenticated
   * user enjoys for the repository. Undefined if the API call
   * was made without an authenticated user or if the repository
   * isn't the primarily requested one (i.e. if this is the parent
   * repository of the requested repository)
   *
   * The permissions hash will also be omitted when the repository
   * information is embedded within another object such as a pull
   * request (base.repo or head.repo).
   *
   * In other words, the only time when the permissions property
   * will be present is when explicitly fetching the repository
   * through the `/repos/user/name` endpoint or similar.
   */
  readonly permissions?: IAPIRepositoryPermissions
}

/*
 * Information about how the user is permitted to interact with a repository.
 */
export interface IAPIRepositoryPermissions {
  readonly admin: boolean
  /* aka 'write' */
  readonly push: boolean
  /* aka 'read' */
  readonly pull: boolean
}

export interface IAPIIdentity {
  readonly id: number
  readonly login: string
  readonly avatar_url: string
  readonly html_url: string
  readonly type: GitHubAccountType
}
