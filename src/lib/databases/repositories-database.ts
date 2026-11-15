// Desktop MIT port; platform imports adapted to Tauri. Dexie replaced by the named JSON store
// (see base-database.ts); the original schema-version migrations have no data to migrate here.
import type { WorkflowPreferences } from "../../upstream/models/workflow-preferences"
import type { GitHubAccountType } from "../api"
import { BaseDatabase } from "./base-database"

export interface IDatabaseOwner {
  readonly id?: number
  /**
   * A case-insensitive lookup key which uniquely identifies a particular
   * user on a particular endpoint. See getOwnerKey for more information.
   */
  readonly key: string
  readonly login: string
  readonly endpoint: string
  readonly type?: GitHubAccountType
}

export interface IDatabaseGitHubRepository {
  readonly id?: number
  readonly ownerID: number
  readonly name: string
  readonly private: boolean | null
  readonly htmlURL: string | null
  readonly cloneURL: string | null

  /** The database ID of the parent repository if the repository is a fork. */
  readonly parentID: number | null
  /** The last time a prune was attempted on the repository */
  readonly lastPruneDate: number | null

  readonly issuesEnabled?: boolean
  readonly isArchived?: boolean

  readonly permissions?: "read" | "write" | "admin" | null
}

/** A record to track the protected branch information for a GitHub repository */
export interface IDatabaseProtectedBranch {
  readonly repoId: number
  /**
   * The branch name associated with the branch protection settings
   *
   * NOTE: this is NOT a fully-qualified ref (i.e. `refs/heads/main`)
   */
  readonly name: string
}

export interface IDatabaseRepository {
  readonly id?: number
  readonly gitHubRepositoryID: number | null
  readonly path: string
  readonly alias: string | null
  readonly missing: boolean

  /** The path to the .git directory for this repository */
  readonly gitDir?: string

  /**
   * The path to the main worktree of this repository, recorded when switching
   * onto one of its linked worktrees.
   */
  readonly mainWorktreePath?: string

  /** The last time the stash entries were checked for the repository */
  readonly lastStashCheckDate?: number | null

  readonly workflowPreferences?: WorkflowPreferences

  /**
   * True if the repository is a tutorial repository created as part
   * of the onboarding flow. Tutorial repositories trigger a tutorial
   * user experience which introduces new users to some core concepts
   * of Git and GitHub.
   */
  readonly isTutorialRepository?: boolean
}

/**
 * Branches are keyed on the ID of the GitHubRepository that they belong to
 * and the short name of the branch.
 */
type BranchKey = [number, string]

/** The repositories database. Schemas are the final (version 9) Desktop ones. */
export class RepositoriesDatabase extends BaseDatabase {
  /** The local repositories table. */
  public readonly repositories = this.table<IDatabaseRepository, number>("repositories", "++id, &path")

  /** The GitHub repositories table. */
  public readonly gitHubRepositories = this.table<IDatabaseGitHubRepository, number>(
    "gitHubRepositories",
    "++id, &[ownerID+name]"
  )

  /** A table containing the names of protected branches per repository. */
  public readonly protectedBranches = this.table<IDatabaseProtectedBranch, BranchKey>(
    "protectedBranches",
    "[repoId+name], repoId"
  )

  /** The GitHub repository owners table. */
  public readonly owners = this.table<IDatabaseOwner, number>("owners", "++id, &key")

  public constructor(name: string) {
    super(name, "data")
  }
}

/* Creates a case-insensitive key used to uniquely identify an owner
 * based on the endpoint and login. Note that the key happens to
 * match the canonical API url for the user. This has no practical
 * purpose but can make debugging a little bit easier.
 */
export function getOwnerKey(endpoint: string, login: string) {
  return `${endpoint}/users/${login}`.toLowerCase()
}
