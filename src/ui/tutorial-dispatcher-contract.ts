import type { Popup } from "../models/popup"
import type { Repository } from "../models/repository"
export interface TutorialDispatcher {
  showGitHubExplore(repository: Repository): void
  showPopup(popup: Popup): void
}
