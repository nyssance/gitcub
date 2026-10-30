// Desktop MIT port; platform imports adapted to Tauri. Dexie replaced by the named JSON store
// (see base-database.ts); the original schema-version migrations have no data to migrate here.
import { BaseDatabase } from "./base-database"

export interface IIssue {
  readonly id?: number
  readonly gitHubRepositoryID: number
  readonly number: number
  readonly title: string
  readonly updated_at?: string
}

export class IssuesDatabase extends BaseDatabase {
  public readonly issues = this.table<IIssue, number>(
    "issues",
    "++id, &[gitHubRepositoryID+number], gitHubRepositoryID, number, [gitHubRepositoryID+updated_at]"
  )

  public constructor(name: string) {
    super(name, "cache")
  }

  public getIssuesForRepository(gitHubRepositoryID: number) {
    return this.issues.where("gitHubRepositoryID").equals(gitHubRepositoryID).toArray()
  }
}
