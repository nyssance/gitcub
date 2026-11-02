import { openUrl } from "@tauri-apps/plugin-opener"
// The only provider adapter for Desktop's shared CI components. No credentials in the renderer.
import { Effect, Fiber } from "effect"
import { Disposable } from "event-kit"

import { APICheckConclusion, APICheckStatus } from "../../lib/api"
import { getCheckRunShortDescription, type ICombinedRefCheck, type IRefCheck } from "../../lib/ci-checks/ci-checks"
import { createCoalescingRunner } from "../../lib/coalescing-runner"
import { ipc } from "../../lib/ipc"
import type { CheckRun, Remote } from "../../models/app-state"
import type { GitHubRepository } from "../../models/github-repository"

export interface RerunRequest {
  checkRuns: ReadonlyArray<IRefCheck>
  repository: GitHubRepository
  prRef: string
  failedOnly: boolean
}
export class ChecksDispatcher {
  private runs = new Map<number, CheckRun>()
  private cached: ICombinedRefCheck | null = null
  private subscribers = new Set<(status: ICombinedRefCheck | null) => void>()
  private polling: Fiber.Fiber<never, never> | undefined
  readonly refresh = createCoalescingRunner(signal => this.fetchChecks(signal))
  readonly supportsRerun = true
  readonly supportsIndividualRerun = true
  constructor(
    private readonly remote: Remote,
    private readonly sha: string,
    readonly pullRequestUrl: string,
    readonly showPopup: (request: RerunRequest) => void,
    private readonly onError: (error: string | null) => void
  ) {}
  tryGetCommitStatus(_repository: GitHubRepository, _ref: string, _branch?: string) {
    return this.cached
  }
  subscribeToCommitStatus(
    _repository: GitHubRepository,
    _ref: string,
    callback: (status: ICombinedRefCheck | null) => void,
    _branch?: string
  ) {
    this.subscribers.add(callback)
    this.polling ??= Effect.runFork(
      Effect.forever(
        Effect.gen({ self: this }, function* () {
          yield* Effect.promise(() => this.refresh())
          yield* Effect.sleep(30_000)
        })
      )
    )
    return new Disposable(() => {
      this.subscribers.delete(callback)
      if (this.subscribers.size === 0) {
        if (this.polling) Effect.runFork(Fiber.interrupt(this.polling))
        this.polling = undefined
        this.refresh.cancel()
      }
    })
  }
  private async fetchChecks(signal: AbortSignal) {
    try {
      const runs = await ipc.checkRuns(this.remote.host, this.remote.owner, this.remote.name, this.sha)
      if (signal.aborted) return
      this.runs.clear()
      const checks = runs.map((run, index): IRefCheck => {
        const id = run.id ?? index + 1
        this.runs.set(id, run)
        const status = Object.values(APICheckStatus).find(value => value === run.status) ?? APICheckStatus.Queued
        const conclusion = Object.values(APICheckConclusion).find(value => value === run.conclusion) ?? null
        return {
          id,
          name: run.name,
          status,
          conclusion,
          htmlUrl: run.url || null,
          description: run.description || getCheckRunShortDescription(status, conclusion),
          appName: run.appName ?? "",
          checkSuiteId: run.checkSuiteId ?? null,
          actionJobSteps: run.steps?.length ? run.steps : undefined,
          actionsWorkflow: run.workflow ?? undefined
        }
      })
      this.cached = {
        checks,
        status: checks.every(c => c.status === APICheckStatus.Completed)
          ? APICheckStatus.Completed
          : APICheckStatus.InProgress,
        conclusion: null
      }
      this.onError(null)
      this.subscribers.forEach(callback => callback(this.cached))
    } catch (error) {
      if (!signal.aborted) this.onError(String(error))
    }
  }
  openInBrowser(url: string) {
    void openUrl(url)
  }
  incrementMetric(_name: string) {
    /* Desktop telemetry is not sent by GitCub. */
  }
  async canRerunChecks(checks: ReadonlyArray<IRefCheck>) {
    const native = checks.flatMap(check => {
      const run = this.runs.get(check.id)
      return run ? [run] : []
    })
    return new Set(await ipc.checkRerunEligibility(this.remote.host, this.remote.owner, this.remote.name, native))
  }
  async rerequestCheckSuites(_repository: GitHubRepository, checks: ReadonlyArray<IRefCheck>, failedOnly: boolean) {
    const targets = new Map<string, CheckRun>()
    for (const check of checks) {
      const run = this.runs.get(check.id)
      if (run?.retry) targets.set(`${run.retry.kind}:${run.retry.id}`, run)
    }
    const results = await Promise.allSettled(
      [...targets.values()].map(run => {
        const individual = checks.length === 1 && !!run.workflow && !!run.jobId
        return ipc.rerunCheck(
          this.remote.host,
          this.remote.owner,
          this.remote.name,
          !individual && !failedOnly && run.checkSuiteId && run.retry?.kind !== "gitlabJob"
            ? { kind: "githubCheckSuite", id: run.checkSuiteId }
            : run.retry!,
          individual ? "job" : failedOnly ? "failed" : "all",
          individual ? run.jobId : undefined
        )
      })
    )
    const errors = results.flatMap(result => (result.status === "rejected" ? [String(result.reason)] : []))
    if (errors.length) throw new Error(errors.join("; "))
  }
  async manualRefreshSubscription(_repository: GitHubRepository, _ref: string, _checks: ReadonlyArray<IRefCheck>) {
    await this.refresh()
  }
}
