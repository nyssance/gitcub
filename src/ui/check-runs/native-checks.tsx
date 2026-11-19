import { useMemo, useState } from "react"

import { useAppStateStore } from "../../features/app-state/store"
import type { PullRequest, Remote } from "../../models/app-state"
import { GitHubRepository } from "../../models/github-repository"
import { Owner } from "../../models/owner"
import { CICheckRunPopover } from "./ci-check-run-popover"
import { CICheckRunRerunDialog } from "./ci-check-run-rerun-dialog"
import { ChecksDispatcher, type RerunRequest } from "./native-checks-dispatcher"

export function NativeChecks({
  repo,
  remote,
  request,
  anchor,
  onClose
}: {
  repo?: string
  remote: Remote
  request: PullRequest
  anchor: HTMLElement
  onClose: () => void
}) {
  const assignment = useAppStateStore(s => (repo ? s.state?.repositoryAccounts?.[repo] : undefined))
  return (
    <RepositoryChecks
      key={JSON.stringify([
        repo,
        remote.host,
        remote.owner,
        remote.name,
        request.headSha,
        assignment?.host,
        assignment?.login,
        assignment?.primary
      ])}
      {...{ repo, remote, request, anchor, onClose }}
    />
  )
}

function RepositoryChecks({ repo, remote, request, anchor, onClose }: Parameters<typeof NativeChecks>[0]) {
  const [pending, setPending] = useState<RerunRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dispatcher = useMemo(
    () => new ChecksDispatcher(remote, request.headSha, request.url, setPending, setError, repo),
    [repo, remote, request.headSha, request.url]
  )
  const repository = useMemo(
    () =>
      new GitHubRepository(
        remote.name,
        new Owner(remote.owner, `https://${remote.host}`, 0),
        0,
        null,
        `https://${remote.host}/${remote.owner}/${remote.name}`
      ),
    [remote]
  )
  return (
    <>
      <CICheckRunPopover
        dispatcher={dispatcher}
        repository={repository}
        branchName={request.head}
        prNumber={request.number}
        anchor={anchor}
        closePopover={() => {
          if (!pending) onClose()
        }}
        error={error}
      />
      {pending && <CICheckRunRerunDialog {...pending} dispatcher={dispatcher} onDismissed={() => setPending(null)} />}
    </>
  )
}
