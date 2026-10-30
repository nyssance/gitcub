// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import type { GitHubRepository } from "../../models/github-repository"
import { LinkButton } from "../desktop/link-button"

interface IRepoRulesetLinkProps {
  readonly repository: GitHubRepository
  readonly rulesetId: number
}

/**
 * Returns a LinkButton to the webpage for the ruleset with the
 * provided ID within the provided repo.
 */
export class RepoRulesetLink extends React.Component<
  React.PropsWithChildren<IRepoRulesetLinkProps>,
  // Preserve the original Desktop component contract.
  Record<string, never>
> {
  public render() {
    const { repository, rulesetId, children } = this.props

    const link = `${repository.htmlURL}/rules/${rulesetId}`

    return (
      <LinkButton uri={link} className="repo-ruleset-link">
        {children}
      </LinkButton>
    )
  }
}
