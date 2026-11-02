import { join } from "node:path"

// GitLens snapshots keep the upstream package layout under upstream/gitlens/packages, so their relative
// imports resolve unchanged. This maps the workspace specifiers the way the upstream package.json files do
// (`@gitlens/<pkg>/<path>.js` → `packages/<pkg>/src/<path>.ts`, `#env/<name>.js` → the Node environment)
// plus the two stand-ins for modules the snapshots do not include: the logging/memoize/serializable decorators
// and the l10n-backed status.utils formatting that GitStatus only reaches from its static helpers.
export function resolveGitLensModule(specifier: string, importer: string, root: string): string | undefined {
  if (specifier.startsWith("@gitlens/utils/decorators/")) return join(root, "gitlens-decorators.ts")
  if (
    specifier === "../utils/status.utils.js" &&
    importer.endsWith("/upstream/gitlens/packages/git/src/models/status.ts")
  )
    return join(root, "gitlens-status-utils.ts")
  // Integration suites: helpers.ts keeps its upstream imports; its provider, git locator, service factory, shadow
  // check and logger resolve to the GitCub provider shim (gitlens-integration.ts).
  if (
    specifier === "@gitlens/utils/logger.js" ||
    (importer.endsWith("/upstream/gitlens/packages/git-cli/src/providers/__tests__/integration/helpers.ts") &&
      /^(?:\.\.\/\.\.\/\.\.\/(?:cliGitProvider|exec\/locator|service)|\.\/shadowCheck)\.js$/.test(specifier))
  )
    return join(root, "gitlens-integration.ts")
  // errors.ts / reference.utils.ts message rendering (gitlens-l10n.ts).
  if (
    specifier === "@vscode/l10n" ||
    (specifier === "@gitlens/utils/date.js" && importer.endsWith("/upstream/gitlens/packages/git/src/errors.ts"))
  )
    return join(root, "gitlens-l10n.ts")
  const workspace = /^@gitlens\/(git|utils)\/(.+)\.js$/.exec(specifier)
  if (workspace) return join(root, "upstream/gitlens/packages", workspace[1], "src", `${workspace[2]}.ts`)
  const environment = /^#env\/(.+)\.js$/.exec(specifier)
  if (environment) return join(root, "upstream/gitlens/packages/utils/src/env/node", `${environment[1]}.ts`)
  return undefined
}
