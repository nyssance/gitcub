// GitLens `packages/git/src/errors.ts` and `utils/reference.utils.ts` render messages through @vscode/l10n, and
// errors.ts formats one count with `@gitlens/utils/date.js`. Neither package is in the snapshot. With no l10n bundle
// loaded @vscode/l10n returns the English source string with its placeholders filled, which is what `t` does here;
// the ported suites only compare error classes and reasons, never message text.
export function t(message: string | { message: string; args?: unknown }, ...args: unknown[]): string {
  if (typeof message === "object")
    return t(message.message, ...(Array.isArray(message.args) ? message.args : [message.args]))
  const values: Record<string, unknown> =
    args.length === 1 && typeof args[0] === "object" && args[0] != null
      ? (args[0] as Record<string, unknown>)
      : (args as unknown as Record<string, unknown>)
  return message.replaceAll(/{([^}]+)}/g, (match, key: string) => {
    const value = values[key]
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : match
  })
}

export function getNumericFormat(style?: "decimal" | "currency" | "percent" | "unit" | null, locale?: string) {
  return new Intl.NumberFormat(locale, { style: style ?? "decimal" }).format
}
