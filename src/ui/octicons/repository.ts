// Desktop MIT port; platform imports adapted to Tauri.

import { CloningRepository } from "../../models/cloning-repository"
import type { Repository } from "../../models/repository"
import * as octicons from "../octicons/octicons.generated"

/**
 * Determine the octicon to display for a given repository.
 */
export function iconForRepository(repository: Repository | CloningRepository) {
  if (repository instanceof CloningRepository) {
    return octicons.desktopDownload
  }

  if (repository.missing) {
    return octicons.alert
  }

  const gitHubRepo = repository.gitHubRepository
  if (!gitHubRepo) {
    return octicons.deviceDesktop
  }

  if (gitHubRepo.isPrivate) {
    return octicons.lock
  }
  if (gitHubRepo.fork) {
    return octicons.repoForked
  }

  return octicons.repo
}
