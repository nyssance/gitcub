// Desktop MIT port; platform imports adapted to Tauri.
// Preserve the original Desktop implementation and contract.
import * as React from "react"

import { type Branch, BranchType } from "../../models/branch"
import { Ref } from "../desktop/ref"
import { Row } from "../desktop/row"
import { Octicon } from "../octicons"
import * as octicons from "../octicons/octicons.generated"

export function renderBranchHasRemoteWarning(branch: Branch) {
  if (branch.upstream != null) {
    return (
      <Row className="warning-helper-text">
        <Octicon symbol={octicons.alert} />
        <p>
          This branch is tracking <Ref>{branch.upstream}</Ref> and renaming this branch will not change the branch name
          on the remote.
        </p>
      </Row>
    )
  } else {
    return null
  }
}

export function renderBranchNameExistsOnRemoteWarning(sanitizedName: string, branches: ReadonlyArray<Branch>) {
  const alreadyExistsOnRemote = branches.some(
    b => b.nameWithoutRemote === sanitizedName && b.type === BranchType.Remote
  )

  if (!alreadyExistsOnRemote) {
    return null
  }

  return (
    <Row className="warning-helper-text">
      <Octicon symbol={octicons.alert} />
      <p>
        A branch named <Ref>{sanitizedName}</Ref> already exists on the remote.
      </p>
    </Row>
  )
}
