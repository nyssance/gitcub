import type { Account } from "../models/account"
import type { GitHubRepository } from "../models/github-repository"
import { getAccountForEndpoint } from "./api"
import type { IssuesStore } from "./stores/issues-store"
export interface IssueDispatcher {
  refreshIssues(repository: GitHubRepository): Promise<void>
}
export class IssuesDispatcher implements IssueDispatcher {
  constructor(
    private readonly issuesStore: IssuesStore,
    private readonly getAccounts: () => readonly Account[]
  ) {}
  async refreshIssues(repository: GitHubRepository) {
    const user = getAccountForEndpoint(this.getAccounts(), repository.endpoint)
    if (!user) return
    try {
      await this.issuesStore.refreshIssues(repository, user)
    } catch (e) {
      log.warn(`Unable to fetch issues for ${repository.fullName}`, e)
    }
  }
}
