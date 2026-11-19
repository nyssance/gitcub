// Desktop MIT port; platform imports adapted to Tauri.

import { useAppStateStore } from "../features/app-state/store"
import type { Account } from "../models/account"
import type { Repository } from "../models/repository"

/** Get the authenticated account for the repository. */
export function getAccountForRepository(accounts: ReadonlyArray<Account>, repository: Repository): Account | null {
  const gitHubRepository = repository.gitHubRepository
  if (!gitHubRepository) {
    return null
  }

  const assigned = useAppStateStore.getState().state?.repositoryAccounts?.[repository.path]
  const endpoint = gitHubRepository.endpoint
  if (assigned) {
    const authority = new URL(endpoint)
    const host =
      authority.hostname === "api.github.com" ? "github.com" : authority.host.replace(/^api\.(.+\.ghe\.com)$/, "$1")
    if (assigned.host !== host) return null
  }
  const login = assigned?.login ?? repository.login
  const candidates = accounts.filter(account => account.endpoint === endpoint)
  if (login) return candidates.find(account => account.login.toLowerCase() === login.toLowerCase()) ?? null
  return candidates.length === 1 ? candidates[0]! : null
}
