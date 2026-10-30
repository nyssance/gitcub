// Desktop MIT port; platform imports adapted to Tauri. Dexie replaced by the named JSON store
// (see base-database.ts); the original schema-version migrations have no data to migrate here.
import type { GitHubRepository } from "../../models/github-repository"
import { BaseDatabase } from "./base-database"

export interface IPullRequestRef {
  /**
   * The database ID of the GitHub repository in which this ref lives. It could
   * be null if the repository was deleted on the site after the PR was opened.
   */
  readonly repoId: number

  /** The name of the ref. */
  readonly ref: string

  /** The SHA of the ref. */
  readonly sha: string
}

export interface IPullRequest {
  /** The GitHub PR number. */
  readonly number: number

  /** The title. */
  readonly title: string

  /** The body of the PR - This is markdown. */
  readonly body: string

  /** The string formatted date on which the PR was created. */
  readonly createdAt: string

  /** The string formatted date on which the PR was created. */
  readonly updatedAt: string

  /** The ref from which the pull request's changes are coming. */
  readonly head: IPullRequestRef

  /** The ref which the pull request is targeting. */
  readonly base: IPullRequestRef

  /** The login of the author. */
  readonly author: string

  /**
   * The draft state of the PR or undefined if state is unknown
   */
  readonly draft: boolean
}

/**
 * Interface describing a record in the
 * pullRequestsLastUpdated table.
 */
interface IPullRequestsLastUpdated {
  /**
   * The primary key. Corresponds to the
   * dbId property for the associated `GitHubRepository`
   * instance.
   */
  readonly repoId: number

  /**
   * The maximum value of the updated_at field on a
   * pull request that we've seen in milliseconds since
   * the epoch.
   */
  readonly lastUpdated: number
}

/**
 * Pull Requests are keyed on the ID of the GitHubRepository
 * that they belong to _and_ the PR number.
 *
 * Index 0 contains the GitHubRepository dbID and index 1
 * contains the PR number.
 */
export type PullRequestKey = [number, number]

export class PullRequestDatabase extends BaseDatabase {
  public readonly pullRequests = this.table<IPullRequest, PullRequestKey>("pullRequests", "[base.repoId+number]")
  public readonly pullRequestsLastUpdated = this.table<IPullRequestsLastUpdated, number>(
    "pullRequestsLastUpdated",
    "repoId"
  )

  public constructor(name: string) {
    super(name, "cache")
  }

  /**
   * Removes all the pull requests associated with the given repository
   * from the database. Also clears the last updated date for that repository
   * if it exists.
   */
  public async deleteAllPullRequestsInRepository(repository: GitHubRepository) {
    await this.transaction("rw", this.pullRequests, this.pullRequestsLastUpdated, async () => {
      await this.clearLastUpdated(repository)
      await this.pullRequests
        .where("[base.repoId+number]")
        .between([repository.dbID], [repository.dbID + 1])
        .delete()
    })
  }

  /**
   * Removes all the given pull requests from the database.
   */
  public async deletePullRequests(keys: PullRequestKey[]) {
    await this.pullRequests.bulkDelete(keys)
  }

  /**
   * Inserts the given pull requests, overwriting any existing records
   * in the process.
   */
  public async putPullRequests(prs: IPullRequest[]) {
    await this.pullRequests.bulkPut(prs)
  }

  /**
   * Retrieve all PRs for the given repository.
   *
   * Note: This method will throw if the GitHubRepository hasn't
   * yet been inserted into the database (i.e the dbID field is null).
   */
  public getAllPullRequestsInRepository(repository: GitHubRepository) {
    return this.pullRequests
      .where("[base.repoId+number]")
      .between([repository.dbID], [repository.dbID + 1])
      .toArray()
  }

  /**
   * Get a single pull requests for a particular repository
   */
  public getPullRequest(repository: GitHubRepository, prNumber: number) {
    return this.pullRequests.get([repository.dbID, prNumber])
  }

  /**
   * Gets a value indicating the most recently updated PR
   * that we've seen for a particular repository.
   *
   * Note:
   * This value might differ from max(updated_at) in the pullRequests
   * table since the most recently updated PR we saw might have
   * been closed and we only store open PRs in the pullRequests
   * table.
   */
  public async getLastUpdated(repository: GitHubRepository) {
    const row = await this.pullRequestsLastUpdated.get(repository.dbID)

    return row ? new Date(row.lastUpdated) : null
  }

  /**
   * Clears the stored date for the most recently updated PR seen for
   * a given repository.
   */
  public async clearLastUpdated(repository: GitHubRepository) {
    await this.pullRequestsLastUpdated.delete(repository.dbID)
  }

  /**
   * Set a value indicating the most recently updated PR
   * that we've seen for a particular repository.
   *
   * Note:
   * This value might differ from max(updated_at) in the pullRequests
   * table since the most recently updated PR we saw might have
   * been closed and we only store open PRs in the pullRequests
   * table.
   */
  public async setLastUpdated(repository: GitHubRepository, lastUpdated: Date) {
    await this.pullRequestsLastUpdated.put({
      repoId: repository.dbID,
      lastUpdated: lastUpdated.getTime()
    })
  }
}

/**
 * Create a pull request key from a GitHub repository and a PR number.
 *
 * This method is mainly a helper function to ensure we don't
 * accidentally swap the order of the repository id and the pr number
 * if we were to create the key array manually.
 *
 * @param repository The GitHub repository to which this PR belongs
 * @param prNumber   The PR number as returned from the GitHub API
 */
export function getPullRequestKey(repository: GitHubRepository, prNumber: number) {
  return [repository.dbID, prNumber] as PullRequestKey
}
