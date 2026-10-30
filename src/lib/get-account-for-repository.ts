// Desktop MIT port; platform imports adapted to Tauri.

import type { Account } from "../models/account"
import type { Repository } from "../models/repository"
import { getAccountForEndpoint } from "./api"

/** Get the authenticated account for the repository. */
export function getAccountForRepository(accounts: ReadonlyArray<Account>, repository: Repository): Account | null {
  const gitHubRepository = repository.gitHubRepository
  if (!gitHubRepository) {
    return null
  }

  return getAccountForEndpoint(accounts, gitHubRepository.endpoint)
}
