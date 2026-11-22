// Desktop MIT port; platform imports adapted to Tauri.
import * as Path from "../lib/platform-path"
import { assertNever, fatalError } from "../upstream/lib/fatal-error"
import { createEqualityHash } from "../upstream/models/equality-hash"
import { ForkContributionTarget, type WorkflowPreferences } from "../upstream/models/workflow-preferences"
import type { IAccountIdentity } from "./account"
import type { IAheadBehind } from "./branch"
import { type ForkedGitHubRepository, GitHubRepository } from "./github-repository"

function getBaseName(path: string): string {
  const baseName = Path.basename(path)

  if (baseName.length === 0) {
    // the repository is at the root of the drive
    // -> show the full path here to show _something_
    return path
  }

  return baseName
}

/** A local repository. */
export class Repository {
  public readonly name: string

  /**
   * A hash of the properties of the object.
   *
   * Objects with the same hash are guaranteed to be structurally equal.
   */
  public hash: string

  /**
   * @param path The working directory of this repository
   * @param missing Was the repository missing on disk last we checked?
   */
  public readonly path: string
  public readonly id: number
  public readonly gitHubRepository: GitHubRepository | null
  public readonly missing: boolean
  public readonly alias: string | null
  public readonly workflowPreferences: WorkflowPreferences
  public readonly isTutorialRepository: boolean
  public readonly gitDir: string | undefined
  public readonly login: string | null
  public readonly mainWorktreePath: string | undefined

  public constructor(
    path: string,
    id: number,
    gitHubRepository: GitHubRepository | null,
    missing: boolean,
    alias: string | null = null,
    workflowPreferences: WorkflowPreferences = {},
    /**
     * True if the repository is a tutorial repository created as part of the
     * onboarding flow. Tutorial repositories trigger a tutorial user experience
     * which introduces new users to some core concepts of Git and GitHub.
     */
    isTutorialRepository: boolean = false,
    /**
     * The path to the .git directory for this repository, or undefined if it
     * hasn't been resolved yet (e.g. for repositories added before this
     * property was introduced).
     */
    gitDir: string | undefined = undefined,
    /**
     * The path to the main worktree of this repository, recorded when Desktop
     * switches onto one of its linked worktrees, or undefined if it hasn't been
     * resolved yet (e.g. for repositories added before this property was
     * introduced).
     *
     * Deleting a linked worktree can take its administrative git metadata with
     * it, so the worktree set is not always discoverable after the fact. This
     * records the main worktree while it is still known.
     */
    mainWorktreePath: string | undefined = undefined,
    login: string | null = null
  ) {
    this.login = login
    this.path = path
    this.id = id
    this.gitHubRepository = gitHubRepository
    this.missing = missing
    this.alias = alias
    this.workflowPreferences = workflowPreferences
    this.isTutorialRepository = isTutorialRepository
    this.gitDir = gitDir
    this.mainWorktreePath = mainWorktreePath
    // Preserve the upstream implementation.
    this.name = gitHubRepository?.name || getBaseName(path)

    this.hash = createEqualityHash(
      path,
      this.id,
      gitHubRepository?.hash,
      this.missing,
      this.alias,
      this.workflowPreferences.forkContributionTarget,
      this.isTutorialRepository,
      this.login
    )
  }

  /**
   * The resolved path to the .git directory for this repository.
   *
   * Uses the stored gitDir if available, otherwise falls back to
   * joining the repository path with '.git'.
   */
  public get resolvedGitDir(): string {
    return this.gitDir ?? Path.join(this.path, ".git")
  }
}

/** Get the account explicitly assigned to a repository, if any. */
export function getRepositoryAccountIdentity(repository: Repository): IAccountIdentity | null {
  const { gitHubRepository, login } = repository
  return gitHubRepository === null || login === null ? null : { endpoint: gitHubRepository.endpoint, login }
}

export function getRepositoryStateKey(repository: Repository): string {
  return repository.id < 0 ? `hash:${repository.hash}` : `${repository.id}:${repository.path}`
}

/** Identical to `Repository`, except it **must** have a `gitHubRepository` */
export type RepositoryWithGitHubRepository = Repository & {
  readonly gitHubRepository: GitHubRepository
}

/**
 * Identical to `Repository`, except it **must** have a `gitHubRepository`
 * which in turn must have a parent. In other words this is a GitHub (.com
 * or Enterprise) fork.
 */
export type RepositoryWithForkedGitHubRepository = Repository & {
  readonly gitHubRepository: ForkedGitHubRepository
}

/**
 * Returns whether the passed repository is a GitHub repository.
 *
 * This function narrows down the type of the passed repository to
 * RepositoryWithGitHubRepository if it returns true.
 */
export function isRepositoryWithGitHubRepository(repository: Repository): repository is RepositoryWithGitHubRepository {
  return repository.gitHubRepository instanceof GitHubRepository
}

/**
 * Asserts that the passed repository is a GitHub repository.
 */
export function assertIsRepositoryWithGitHubRepository(
  repository: Repository
): asserts repository is RepositoryWithGitHubRepository {
  if (!isRepositoryWithGitHubRepository(repository)) {
    return fatalError(`Repository must be GitHub repository`)
  }
}

/**
 * Returns whether the passed repository is a GitHub fork.
 *
 * This function narrows down the type of the passed repository to
 * RepositoryWithForkedGitHubRepository if it returns true.
 */
export function isRepositoryWithForkedGitHubRepository(
  repository: Repository
): repository is RepositoryWithForkedGitHubRepository {
  return isRepositoryWithGitHubRepository(repository) && repository.gitHubRepository.parent !== null
}

/**
 * A snapshot for the local state for a given repository
 */
export interface ILocalRepositoryState {
  /**
   * The ahead/behind count for the current branch, or `null` if no tracking
   * branch found.
   */
  readonly aheadBehind: IAheadBehind | null
  /**
   * The number of uncommitted changes currently in the repository.
   */
  readonly changedFilesCount: number
}

/**
 * Returns the owner/name alias if associated with a GitHub repository,
 * otherwise the folder name that contains the repository
 */
export function nameOf(repository: Repository) {
  const { gitHubRepository } = repository

  return gitHubRepository !== null ? gitHubRepository.fullName : repository.name
}

/**
 * Get the GitHub html URL for a repository, if it has one.
 * Will return the parent GitHub repository's URL if it has one.
 * Otherwise, returns null.
 */
export function getGitHubHtmlUrl(repository: Repository): string | null {
  if (!isRepositoryWithGitHubRepository(repository)) {
    return null
  }

  return getNonForkGitHubRepository(repository).htmlURL
}

/**
 * Attempts to honor the Repository's workflow preference for GitHubRepository contributions.
 * Falls back to returning the GitHubRepository when a non-fork repository
 * is passed, returns the parent GitHubRepository otherwise.
 */
export function getNonForkGitHubRepository(repository: RepositoryWithGitHubRepository): GitHubRepository {
  if (!isRepositoryWithForkedGitHubRepository(repository)) {
    // If the repository is not a fork, we don't have to worry about anything.
    return repository.gitHubRepository
  }

  const forkContributionTarget = getForkContributionTarget(repository)

  switch (forkContributionTarget) {
    case ForkContributionTarget.Self:
      return repository.gitHubRepository
    case ForkContributionTarget.Parent:
      return repository.gitHubRepository.parent
    default:
      return assertNever(forkContributionTarget, "Invalid fork contribution target")
  }
}

/**
 * Returns a non-undefined forkContributionTarget for the specified repository.
 */
export function getForkContributionTarget(repository: Repository): ForkContributionTarget {
  return repository.workflowPreferences.forkContributionTarget ?? ForkContributionTarget.Parent
}

/**
 * Returns whether the fork is contributing to the parent
 */
export function isForkedRepositoryContributingToParent(repository: Repository): boolean {
  return (
    isRepositoryWithForkedGitHubRepository(repository) &&
    getForkContributionTarget(repository) === ForkContributionTarget.Parent
  )
}
