/**
 * Desktop 的 fork 行为（workflowPreferences.forkContributionTarget）：fork 默认为上游贡献，
 * PR 列表、新建 Issue、「在网页查看」和新分支的默认基点都指向上游；选了「自用」就都回到 fork 本身。
 * 偏好按路径存在 Desktop 仓库库里，和原版一样跟着仓库走。
 */
import type { Remote } from "@/models/app-state"
import { ForkContributionTarget } from "@/upstream/models/workflow-preferences"

import { getDesktopRuntime } from "./desktop-runtime"
import { ipc } from "./ipc"

const sameRepository = (a: Remote, b: Remote) => a.host === b.host && a.owner === b.owner && a.name === b.name

const findRepository = async (path: string) =>
  (await getDesktopRuntime().repositoriesStore.getAll()).find(repository => repository.path === path) ?? null

/** Desktop getForkContributionTarget：没设过就是 Parent */
export async function readForkContributionTarget(path: string) {
  return (await findRepository(path))?.workflowPreferences.forkContributionTarget ?? ForkContributionTarget.Parent
}

export async function writeForkContributionTarget(path: string, forkContributionTarget: ForkContributionTarget) {
  const store = getDesktopRuntime().repositoriesStore
  const repository = await findRepository(path)
  if (!repository) throw new Error(`Repository is not registered: ${path}`)
  await store.updateRepositoryWorkflowPreferences(repository, {
    ...repository.workflowPreferences,
    forkContributionTarget
  })
}

/** 远端仓库 fork 自哪里；不是 fork 就是 null */
export async function forkParent(remote: Remote) {
  const parent = await ipc.pullRequestRepository(remote.host, remote.owner, remote.name)
  return sameRepository(parent, remote) ? null : parent
}

/** Desktop getNonForkGitHubRepository：fork 且为上游贡献时是上游，否则是远端本身 */
export async function contributionRepository(path: string, remote: Remote): Promise<Remote> {
  const parent = await forkParent(remote)
  if (!parent) return remote
  return (await readForkContributionTarget(path)) === ForkContributionTarget.Self ? remote : parent
}

/** Desktop GitStore.refreshDefaultBranch：只有为上游贡献时才用 upstream 远端的默认分支 */
export async function contributesToParent(path: string) {
  return (await readForkContributionTarget(path)) === ForkContributionTarget.Parent
}
