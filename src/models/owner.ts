// Desktop MIT port; imports adapted to Tauri.
import type { GitHubAccountType } from "../lib/desktop-api-urls"

/** The owner of a GitHubRepository. */
export class Owner {
  /**
   * @param id The database ID. This may be null if the object wasn't retrieved from the database.
   */
  public readonly login: string
  public readonly endpoint: string
  public readonly id: number
  public readonly type?: GitHubAccountType

  public constructor(login: string, endpoint: string, id: number, type?: GitHubAccountType) {
    this.login = login
    this.endpoint = endpoint
    this.id = id
    this.type = type
  }
}
