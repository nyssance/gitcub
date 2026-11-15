/** Explicit scope change: GitCub searches commits locally with git and leaves hosted-platform search to the
 * GitHub/GitLab web UI, so GitLens's `parseSearchQueryGitHubCommand` (GitHub search API query builder) is not
 * ported. Snapshots stay unchanged; the suite block and its import are dropped at load time and the file is
 * registered `partial` in tests/gitlens/manifest.json with the excluded suite title. */
export function withoutGitHubSearchCommand(file: string, source: string): string {
  if (file === "gitlens/search.utils.test.ts") {
    const stripped = source
      .replace(/^\tparseSearchQueryGitHubCommand,\n/m, "")
      .replace(/^\tsuite\('parseSearchQueryGitHubCommand', \(\) => \{\n[\s\S]*?\n\t\}\);\n\n(?=\tsuite\(')/m, "")
    if (stripped.includes("parseSearchQueryGitHubCommand")) throw new Error("GitHub search suite layout changed")
    return stripped
  }
  return source
}
