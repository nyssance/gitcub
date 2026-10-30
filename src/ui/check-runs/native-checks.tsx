import { useMemo, useState } from "react"

import type { PullRequest, Remote } from "../../models/app-state"
import { GitHubRepository } from "../../models/github-repository"
import { Owner } from "../../models/owner"
import { CICheckRunPopover } from "./ci-check-run-popover"
import { CICheckRunRerunDialog } from "./ci-check-run-rerun-dialog"
import { ChecksDispatcher, type RerunRequest } from "./native-checks-dispatcher"

export function NativeChecks({
  remote,
  request,
  anchor,
  onClose
}: {
  remote: Remote
  request: PullRequest
  anchor: HTMLElement
  onClose: () => void
}) {
  const [pending, setPending] = useState<RerunRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dispatcher = useMemo(
    () => new ChecksDispatcher(remote, request.headSha, request.url, setPending, setError),
    [remote, request.headSha, request.url]
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
