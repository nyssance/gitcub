// Desktop MIT port; platform imports adapted to Tauri. Dexie replaced by the named JSON store
// (see base-database.ts); the original schema-version migrations have no data to migrate here.
import { BaseDatabase } from "./base-database"

export interface IMentionableUser {
  /**
   * The username or "handle" of the user.
   */
  readonly login: string

  /**
   * The real name (or at least the name that the user
   * has configured to be shown) or null if the user hasn't
   * specified a name.
   */
  readonly name: string | null

  /**
   * The user's attributable email address. If the
   * user doesn't have a public profile email address
   * this will instead contain an automatically generated
   * stealth email address based on the account endpoint
   * and login.
   */
  readonly email: string

  /**
   * A url to an avatar image chosen by the user
   */
  readonly avatarURL: string
}

interface IDBMentionableUser extends IMentionableUser {
  /**
   * The id corresponding to the dbID property of the
   * `GitHubRepository` instance that this user is associated
   * with
   */
  readonly gitHubRepositoryID: number
}

/**
 * An object containing information about when a specific
 * repository's mentionable users was last fetched and
 * the ETag of that request.
 */
export interface IMentionableCacheEntry {
  readonly gitHubRepositoryID: number
  /**
   * The time (in milliseconds since the epoch) that
   * the mentionable users was last updated for this
   * repository
   */
  readonly lastUpdated: number

  /**
   * The ETag returned by the server the last time
   * we issued a request to get the mentionable users
   */
  readonly eTag: string | undefined
}

export class GitHubUserDatabase extends BaseDatabase {
  public readonly mentionables = this.table<IDBMentionableUser, [number, string]>(
    "mentionables",
    "&[gitHubRepositoryID+login], gitHubRepositoryID"
  )
  public readonly mentionableCache = this.table<IMentionableCacheEntry, number>(
    "mentionableCache",
    "gitHubRepositoryID"
  )

  public constructor(name: string) {
    super(name, "cache")
  }

  /**
   * Persist all the mentionable users provided for the given
   * gitHubRepositoryID and update the lastUpdated property and
   * ETag for the mentionable cache entry.
   */
  public updateMentionablesForRepository(
    gitHubRepositoryID: number,
    mentionables: ReadonlyArray<IMentionableUser>,
    eTag: string | undefined
  ) {
    return this.transaction("rw", this.mentionables, this.mentionableCache, async () => {
      await this.mentionables.where("gitHubRepositoryID").equals(gitHubRepositoryID).delete()

      await this.touchMentionableCacheEntry(gitHubRepositoryID, eTag)
      await this.mentionables.bulkAdd(mentionables.map(x => ({ ...x, gitHubRepositoryID })))
    })
  }

  /**
   * Retrieve all persisted mentionable users for the provided
   * `gitHubRepositoryID`
   */
  public async getAllMentionablesForRepository(gitHubRepositoryID: number): Promise<ReadonlyArray<IMentionableUser>> {
    const mentionables = await this.mentionables.where("gitHubRepositoryID").equals(gitHubRepositoryID).toArray()

    return mentionables.map(toMentionableUser)
  }

  /**
   * Get the cache entry (or undefined if no cache entry has
   * been written yet) for the `gitHubRepositoryID`. The
   * cache entry contains information on when the repository
   * mentionables was last refreshed as well as the ETag of
   * the previous request.
   */
  public getMentionableCacheEntry(gitHubRepositoryID: number) {
    return this.mentionableCache.get(gitHubRepositoryID)
  }

  /**
   * Set the lastUpdated property for the cache entry to
   * now and update the ETag
   */
  public touchMentionableCacheEntry(gitHubRepositoryID: number, eTag: string | undefined) {
    const lastUpdated = Date.now()
    const entry = { gitHubRepositoryID, lastUpdated, eTag }

    return this.mentionableCache.put(entry)
  }
}

function toMentionableUser(mentionable: IDBMentionableUser): IMentionableUser {
  // Exclude the githubRepositoryID prop
  const { login, email, avatarURL, name } = mentionable
  return { login, email, avatarURL, name }
}
