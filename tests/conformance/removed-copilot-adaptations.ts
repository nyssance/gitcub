/** Explicit scope change: Copilot was removed at the user's request on 2026-10-21.
 * Snapshots stay unchanged. Shared suites retain all non-Copilot assertions. */
export function withoutRemovedCopilot(file: string, source: string): string {
  if (file === "desktop/oauth-authentication-test.ts") {
    // Token exchange + profile + emails + flags; the Copilot GraphQL call was removed.
    return source.replaceAll("harness.fetchMock.mock.callCount(), 5", "harness.fetchMock.mock.callCount(), 4")
  }
  if (file === "desktop/refresh-token-consumers-test.ts") {
    return source
      .replace(/^import \{ createCopilotTokenProvider \}[^\n]*\n/m, "")
      .replace(/describe\('Refreshing Copilot session credentials',[\s\S]*$/, "")
  }
  if (file === "desktop/main-process/menu-test.ts") {
    return source
      .replace(/^import \{ enableCopilotAppHandoff \}[^\n]*\n/m, "")
      .replace(/ {4}it\('gates Copilot handoff[\s\S]*?(?= {4}\/\/ The boolean parameters)/, "")
      .replace(
        / {6}const copilot = repository\.submenu\.find\([\s\S]*?(?= {6}assert\.ok\(\n {8}repository\.submenu\.some)/,
        ""
      )
  }
  if (file === "desktop/account-token-lifecycle-test.ts") {
    // Profile refresh no longer requests Copilot capabilities; preserve every session assertion.
    return source.replace(/^.*t\.mock\.method\(API\.prototype, 'fetchUserCopilotInfo'[^\n]*\n/m, "")
  }
  if (file === "desktop/api-test.ts") {
    return source.replace(
      / {2}describe\('getDiffChangesCommitMessage',[\s\S]*?(?= {2}describe\('fetchProtectedBranches')/,
      ""
    )
  }
  if (file === "desktop/repo-rules-test.ts") {
    return source
      .replace(/^import \{ getEnforcedRuleDescriptions \}[^\n]*\n/m, "")
      .replace(/describe\('getEnforcedRuleDescriptions',[\s\S]*$/, "")
  }
  if (file.startsWith("desktop/stores/app-store-")) {
    return source
      .replace(/ {4}const \{ CopilotStore \} = await import\([\s\S]*?\n {4}\)\n/, "")
      .replace(/,\s*new CopilotStore\([^\n]*\)/, "")
      .replaceAll(/^.*appStore\['updateCopilot[^\n]*\n/gm, "")
  }
  if (file === "desktop/stats-store-test.ts") {
    return source.replace(
      / {2}it\('tracks GitHub Copilot app handoffs'[\s\S]*?(?= {2}it\('persists token refresh counters)/,
      ""
    )
  }
  if (file === "desktop/usage-data-test.ts") {
    // The checked-in example still lists Desktop's Copilot measures and dimension; compare the rest byte for byte.
    return source.replace(
      "const checkedInExample = await readFile(examplePath, 'utf8')",
      "const checkedInExample = (await readFile(examplePath, 'utf8')).replace(/^ *\"(?:copilot\\w*|openInCopilotAppCount|initiateResolveConflictsWithCopilotCount|generateCommitMessage\\w*)\": [^\\n]*\\n/gm, '')"
    )
  }
  return source
}
