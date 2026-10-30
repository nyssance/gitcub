// `packages/git/src/utils/status.utils.ts` formats localized summaries through @vscode/l10n. GitStatus only
// reaches it from the static getFormattedDiffStatus/getUpstreamStatus helpers, which no ported suite calls.
export function getFormattedDiffStatus(): never {
  throw new Error("GitLens status.utils formatting is not ported")
}

export function getUpstreamStatus(): never {
  throw new Error("GitLens status.utils formatting is not ported")
}
