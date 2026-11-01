import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { withoutNativeDetails } from "./design-adaptations"
import desktopUIPaths from "./desktop-ui-paths.json"
import { withGitLensIntegrationGlobals } from "./gitlens-integration-adaptations"
import { resolveGitLensModule } from "./gitlens-modules"
import { withoutUnportedGitLensBlocks } from "./gitlens-unported-blocks"
import { withoutGitHubSearchCommand } from "./hosted-search-adaptations"
import { withoutRemovedCopilot } from "./removed-copilot-adaptations"
import { adaptUIDom } from "./ui-dom-adaptations"

const root = import.meta.dirname
const temporary = await mkdtemp(join(tmpdir(), "gitcub-upstream-"))
const buildDirectory = await mkdtemp(join(root, "../../node_modules/.gitcub-conformance-"))
const adapter = join(root, "bridge.ts")
const fixtures = join(root, "fixtures.ts")
const upstream = (path: string) => join(root, "../../src/upstream", path)
// GitLens integration 套件共用的 helpers.ts 快照；它自己的导入按套件的 gitlensHelperImports 解析。
const gitlensIntegrationHelpers = join(
  root,
  "upstream/gitlens/packages/git-cli/src/providers/__tests__/integration/helpers.ts"
)
const gitlensIntegrationLocal = join(root, "gitlens-integration-local.ts")
const gitlensLocalHelperImports = {
  "@gitlens/utils/logger.js": gitlensIntegrationLocal,
  "@gitlens/utils/uri.js": join(root, "upstream/gitlens/packages/utils/src/uri.ts"),
  "../../../cliGitProvider.js": gitlensIntegrationLocal,
  "../../../exec/locator.js": gitlensIntegrationLocal,
  "../../../service.js": gitlensIntegrationLocal,
  "./shadowCheck.js": gitlensIntegrationLocal
}
const suites = [
  {
    file: "desktop/e2e/app-launch-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "./e2e-fixtures": join(root, "e2e/fixtures.ts"),
      "./test-helpers": join(root, "upstream/desktop/e2e/test-helpers.ts"),
      "../../package-info": join(root, "../../src/lib/app-version.ts")
    }
  },
  {
    file: "desktop/stores/app-store-token-refresh-stats-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../../src/lib/stores/app-store": join(root, "../../src/lib/stores/app-store.ts"),
      "../../../src/lib/stores/accounts-store": join(root, "../../src/lib/stores/accounts-store.ts"),
      "../../../src/lib/stats": join(root, "../../src/lib/stats/index.ts"),
      "../../helpers/databases/test-stats-database": join(
        root,
        "upstream/desktop/helpers/databases/test-stats-database.ts"
      ),
      "../../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../../src/lib/oauth-token": join(root, "../../src/lib/oauth-token.ts"),
      "../../../src/lib/stores/alive-store": join(root, "../../src/lib/stores/alive-store.ts"),

      "../../../src/lib/stores/notifications-store": join(root, "../../src/lib/stores/notifications-store.ts"),
      "../../../src/lib/stores/pull-request-coordinator": join(
        root,
        "../../src/lib/stores/pull-request-coordinator.ts"
      ),
      "../../helpers/app-store-test-harness": join(root, "upstream/desktop/helpers/app-store-test-harness.ts"),
      "../../helpers/stores": join(root, "upstream/desktop/helpers/stores/index.ts"),
      "../../helpers/test-activity-monitor": join(root, "upstream/desktop/helpers/test-activity-monitor.ts"),
      "../../fake-stats-post": join(root, "upstream/desktop/fake-stats-post.ts")
    }
  },
  {
    file: "desktop/stores/app-store-indicators-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../../src/lib/stores/app-store": join(root, "../../src/lib/stores/app-store.ts"),
      "../../helpers/databases/test-stats-database": join(
        root,
        "upstream/desktop/helpers/databases/test-stats-database.ts"
      ),
      "../../../src/models/cloning-repository": join(root, "../../src/models/cloning-repository.ts"),
      "../../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../../src/lib/stores/alive-store": join(root, "../../src/lib/stores/alive-store.ts"),

      "../../../src/lib/stores/notifications-store": join(root, "../../src/lib/stores/notifications-store.ts"),
      "../../../src/lib/stores/pull-request-coordinator": join(
        root,
        "../../src/lib/stores/pull-request-coordinator.ts"
      ),
      "../../helpers/app-store-test-harness": join(root, "upstream/desktop/helpers/app-store-test-harness.ts"),
      "../../../src/lib/stats": join(root, "../../src/lib/stats/index.ts"),
      "../../helpers/test-activity-monitor": join(root, "upstream/desktop/helpers/test-activity-monitor.ts"),
      "../../fake-stats-post": join(root, "upstream/desktop/fake-stats-post.ts")
    }
  },

  {
    file: "desktop/git/refreshable-credentials-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git": join(root, "../../src/lib/git-authenticated.ts"),
      "../../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../../src/lib/stores/accounts-store": join(root, "../../src/lib/stores/accounts-store.ts"),
      "../../../src/lib/trampoline/trampoline-server": join(root, "../../src/lib/trampoline/trampoline-server.ts"),
      "../../../src/lib/trampoline/trampoline-command": join(root, "../../src/lib/trampoline/trampoline-command.ts"),
      "../../../src/lib/trampoline/trampoline-credential-helper": join(
        root,
        "../../src/lib/trampoline/trampoline-credential-helper.ts"
      ),
      "../../helpers/stores": join(root, "upstream/desktop/helpers/stores/index.ts"),
      "../../helpers/repositories": fixtures,
      "../../helpers/repository-scaffolding": fixtures,
      "../../helpers/temp": join(root, "upstream/desktop/helpers/temp.ts"),
      dugite: join(root, "git-process.ts")
    }
  },
  {
    file: "desktop/ipc-contract-test.ts",
    globals: false,
    imports: { "../../src/lib/ipc-shared": join(root, "../../src/lib/ipc-shared.ts") }
  },
  {
    file: "desktop/main-process/spell-checker-menu-test.ts",
    globals: false,
    imports: {
      "../../../src/main-process/menu/build-spell-check-menu": join(root, "../../src/lib/menu/spellcheck.ts"),
      "../../helpers/menus/available-spellchecker-languages-helper": join(
        root,
        "upstream/desktop/helpers/menus/available-spellchecker-languages-helper.ts"
      )
    }
  },
  {
    file: "desktop/main-process/menu-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../../src/main-process/menu": join(root, "../../src/lib/menu/build-default-menu.ts"),
      "../../../src/lib/feature-flag": join(root, "../../src/lib/desktop-features.ts")
    }
  },

  {
    file: "desktop/native-module-build-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      typescript: join(root, "typescript-native-build.mjs"),
      "../vendor/desktop-notifications/package.json": join(
        root,
        "upstream/desktop/vendor/desktop-notifications/package.json"
      ),
      "../vendor/desktop-trampoline/package.json": join(
        root,
        "upstream/desktop/vendor/desktop-trampoline/package.json"
      ),
      "../vendor/windows-argv-parser/package.json": join(
        root,
        "upstream/desktop/vendor/windows-argv-parser/package.json"
      )
    }
  },
  {
    file: "desktop/tailer-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../src/lib/tailer": join(root, "../../src/lib/tailer.ts"),
      "../../src/lib/file-system": join(root, "../../src/lib/tail-by-line.ts"),
      "../helpers/temp": join(root, "upstream/desktop/helpers/temp.ts")
    }
  },
  {
    file: "desktop/get-shell-env-test.ts",
    globals: false,
    imports: {
      "../../src/lib/hooks/get-shell-env": join(root, "../../src/lib/hooks/get-shell-env.ts"),
      printenvz: join(root, "printenvz.ts")
    }
  },
  {
    file: "desktop/cygwin-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../src/lib/shells/win32": join(root, "cygwin.ts"),
      "../helpers/temp": join(root, "upstream/desktop/helpers/temp.ts")
    }
  },

  {
    file: "desktop/refresh-token-consumers-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../src/lib/stores/accounts-store": join(root, "../../src/lib/stores/accounts-store.ts"),
      "../../src/lib/credential-sessions": join(root, "../../src/lib/credential-sessions.ts"),

      "../../src/lib/trampoline/trampoline-credential-helper": join(
        root,
        "../../src/lib/trampoline/trampoline-credential-helper.ts"
      ),
      "../../src/lib/trampoline/trampoline-command": join(root, "../../src/lib/trampoline/trampoline-command.ts"),
      "../../src/lib/trampoline/trampoline-environment": join(
        root,
        "../../src/lib/trampoline/trampoline-environment.ts"
      ),
      "../../src/lib/trampoline/trampoline-ui-helper": join(root, "../../src/lib/trampoline/trampoline-ui-helper.ts"),
      "../../src/lib/git/credential": join(root, "../../src/lib/git/credential.ts"),
      "../../src/lib/oauth-token": join(root, "../../src/lib/oauth-token.ts"),
      "../helpers/stores": join(root, "upstream/desktop/helpers/stores/index.ts")
    }
  },
  {
    file: "desktop/ui/clone-repository-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../../src/models/clone-repository-tab": join(root, "../../src/upstream/models/clone-repository-tab.ts"),
      "../../../src/ui/clone-repository/clone-repository": join(
        root,
        "../../src/ui/clone-repository/clone-repository.tsx"
      ),
      "../../../src/ui/dispatcher": join(root, "../../src/ui/clone-dispatcher-contract.ts"),
      "../../../src/ui/lib/default-dir": join(root, "../../src/lib/ui/default-dir.ts"),
      "../../helpers/temp": join(root, "upstream/desktop/helpers/temp.ts"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/notifications-store-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../src/lib/stores/notifications-store": join(root, "../../src/lib/stores/notifications-store.ts"),
      "../../src/lib/stores/alive-store": join(root, "../../src/lib/stores/alive-store.ts"),
      "../../src/lib/stores/pull-request-coordinator": join(root, "../../src/lib/stores/pull-request-coordinator.ts"),
      "../helpers/app-store-test-harness": join(root, "upstream/desktop/helpers/app-store-test-harness.ts"),
      "../../src/lib/stats": join(root, "stats-store.ts"),
      "../helpers/databases": join(root, "upstream/desktop/helpers/databases/test-stats-database.ts"),
      "../helpers/test-activity-monitor": join(root, "upstream/desktop/helpers/test-activity-monitor.ts"),
      "../helpers/test-stats-store": join(root, "upstream/desktop/helpers/test-stats-store.ts"),
      "../fake-stats-post": join(root, "upstream/desktop/fake-stats-post.ts"),
      "../helpers/repositories": fixtures,
      "../helpers/repository-scaffolding": fixtures,
      "../helpers/git": adapter,
      "../helpers/mock-api": join(root, "upstream/desktop/helpers/mock-api.ts")
    }
  },
  {
    file: "desktop/usage-data-test.ts",
    unbundled: true,
    globals: false,
    imports: { "../helpers/usage-data": join(root, "usage-data.ts") }
  },
  {
    file: "desktop/stats-store-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../helpers/databases": join(root, "upstream/desktop/helpers/databases/test-stats-database.ts"),
      "../helpers/mock-notification": join(root, "upstream/desktop/helpers/mock-notification.ts"),
      "../../src/lib/stats": join(root, "stats-store.ts"),
      "../helpers/test-activity-monitor": join(root, "upstream/desktop/helpers/test-activity-monitor.ts"),
      "../fake-stats-post": join(root, "upstream/desktop/fake-stats-post.ts"),
      "../../src/lib/credential-sessions": join(root, "../../src/lib/credential-sessions.ts"),
      "../../src/lib/stats/stats-store": join(root, "../../src/lib/stats/stats-store.ts")
    }
  },
  {
    file: "desktop/desktop-file-transport-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../src/main-process/desktop-file-transport": join(root, "desktop-log.ts"),
      "../helpers/temp": join(root, "upstream/desktop/helpers/temp.ts"),
      "triple-beam": join(root, "triple-beam.ts")
    }
  },
  {
    file: "desktop/desktop-console-transport-test.ts",
    globals: false,
    imports: { "../../src/main-process/desktop-console-transport": join(root, "desktop-log.ts") }
  },
  { file: "desktop/native-notifications-windows-test.ts", unbundled: true, globals: false, imports: {} },
  { file: "desktop/native-notifications-test.ts", unbundled: true, globals: false, imports: {} },
  {
    file: "desktop/show-notification-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../helpers/mock-ipc": join(root, "upstream/desktop/helpers/mock-ipc.ts"),
      "../helpers/mock-notification": join(root, "upstream/desktop/helpers/mock-notification.ts"),
      "../../src/lib/notifications/show-notification": join(root, "../../src/lib/notifications/show-notification.ts"),
      "../../src/lib/notifications/notification-handler": join(
        root,
        "../../src/lib/notifications/notification-handler.ts"
      )
    }
  },
  {
    file: "desktop/notification-permission-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../helpers/mock-ipc": join(root, "upstream/desktop/helpers/mock-ipc.ts"),
      "../helpers/mock-notification": join(root, "upstream/desktop/helpers/mock-notification.ts"),
      "../../src/lib/notifications/notification-permission": join(
        root,
        "../../src/lib/notifications/system-permission.ts"
      )
    }
  },
  {
    file: "desktop/ui/small-action-and-dialog-surfaces-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../../src/ui/check-runs/ci-check-run-no-steps": join(
        root,
        "../../src/ui/check-runs/ci-check-run-no-steps.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/tutorial-welcome-surfaces-test.ts",
    globals: false,
    imports: {
      "../../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../../../src/models/owner": join(root, "../../src/models/owner.ts"),
      "../../../src/models/popup": join(root, "../../src/models/popup.ts"),
      "../../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../../src/models/tutorial-step": join(root, "../../src/upstream/models/tutorial-step.ts"),
      "../../../src/ui/dispatcher": join(root, "../../src/ui/tutorial-dispatcher-contract.ts"),
      "../../../src/ui/tutorial/done": join(root, "../../src/ui/tutorial/done.tsx"),
      "../../../src/ui/tutorial/tutorial-step-instruction": join(
        root,
        "../../src/ui/tutorial/tutorial-step-instruction.tsx"
      ),
      "../../../src/ui/tutorial/welcome": join(root, "../../src/ui/tutorial/welcome.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/welcome-and-sign-in-wrappers-test.ts",
    globals: false,
    imports: {
      "../../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../../src/lib/stores/sign-in-store": join(root, "../../src/lib/stores/sign-in-store.ts"),
      "../../../src/ui/dispatcher": join(root, "../../src/ui/sign-in-contract.ts"),
      "../../../src/ui/welcome/configure-git": join(root, "../../src/ui/welcome/configure-git.tsx"),
      "../../../src/ui/welcome/sign-in-enterprise": join(root, "../../src/ui/welcome/sign-in-enterprise.tsx"),
      "../../../src/ui/lib/sign-in": join(root, "../../src/ui/sign-in/sign-in-flow.tsx"),
      "../../../src/ui/sign-in/sign-in": join(root, "../../src/ui/sign-in/sign-in.tsx"),
      "../../../src/lib/trampoline/trampoline-ui-helper": join(
        root,
        "../../src/lib/trampoline/trampoline-ui-helper.ts"
      ),
      "../../../src/models/popup": join(root, "../../src/models/popup.ts"),
      "../../helpers/app-store-test-harness": join(root, "upstream/desktop/helpers/app-store-test-harness.ts"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/repository-directory-exceptions-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../../src/lib/git/rev-parse": join(root, "../../src/lib/repository-access.ts"),
      "../../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../../src/ui/dispatcher": join(root, "../../src/ui/repository-actions-contract.ts"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/helper-side-effect-surfaces-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../../src/ui/app-theme": join(root, "../../src/ui/app-theme.tsx"),
      "../../../src/ui/lib/application-theme": join(root, "../../src/lib/ui/application-theme.ts"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },

  {
    file: "desktop/open-file-test.ts",
    globals: false,
    imports: {
      "../../src/lib/app-shell": join(root, "../../src/lib/app-shell.ts"),
      "../../src/ui/dispatcher": join(root, "../../src/ui/file-error-contract.ts"),
      "../../src/ui/lib/open-file": join(root, "../../src/lib/ui/open-file.ts")
    }
  },
  {
    file: "desktop/multi-commit-operation-test.ts",
    globals: false,
    imports: {
      "../../src/models/multi-commit-operation": join(root, "../../src/models/multi-commit-operation.ts"),
      "../../src/lib/multi-commit-operation": join(root, "../../src/lib/multi-commit-operation.ts"),
      "../../src/models/tip": join(root, "../../src/models/tip.ts")
    }
  },
  {
    file: "desktop/main-process-proxy-test.ts",
    globals: false,
    imports: {
      "../../src/lib/is-application-bundle": join(root, "../../src/lib/is-application-bundle.ts"),
      "../../src/ui/main-process-proxy": join(root, "../../src/lib/show-folder-contents.ts")
    }
  },

  {
    file: "desktop/popup-manager-test.ts",
    globals: false,
    imports: {
      "../../src/lib/popup-manager": join(root, "../../src/lib/popup-manager.ts"),
      "../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../src/models/popup": join(root, "../../src/models/popup.ts")
    }
  },
  {
    file: "desktop/authenticated-image-token-handler-test.ts",
    globals: false,
    imports: {
      "../../src/lib/authenticated-image-token-handler": join(
        root,
        "../../src/lib/images/authenticated-image-token-handler.ts"
      ),
      "../helpers/mock-ipc": join(root, "upstream/desktop/helpers/mock-ipc.ts")
    }
  },
  {
    file: "desktop/authenticated-image-token-resolver-test.ts",
    globals: false,
    imports: {
      "../../src/main-process/authenticated-image-token-resolver": join(
        root,
        "../../src/lib/images/authenticated-image-token-resolver.ts"
      ),
      "../../src/main-process/trusted-ipc-sender": join(root, "../../src/lib/images/trusted-ipc-sender.ts")
    }
  },
  {
    file: "desktop/authenticated-image-filter-test.ts",
    globals: false,
    imports: {
      "../../src/main-process/authenticated-image-filter": join(
        root,
        "../../src/lib/images/authenticated-image-filter.ts"
      ),
      "../../src/main-process/ordered-webrequest": join(root, "../../src/lib/images/ordered-webrequest.ts")
    }
  },
  {
    file: "desktop/git/environment-test.ts",
    globals: false,
    imports: { "../../../src/lib/git/environment": join(root, "../../src/lib/git/proxy-environment.ts") }
  },

  {
    file: "desktop/ui/side-by-side-diff-row-test.ts",
    globals: false,
    imports: {
      "../../../src/models/diff": join(root, "../../src/upstream/models/diff/index.ts"),
      "../../../src/ui/diff/side-by-side-diff-row": join(root, "../../src/ui/diff/side-by-side-diff-row.tsx"),
      "../../../src/ui/diff/diff-helpers": join(root, "../../src/upstream/ui/diff/diff-helpers.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/section-list-scroll-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/lib/list/section-list": join(root, "../../src/ui/desktop/list/section-list.tsx"),
      "../../../src/ui/lib/list/list-row-index-path": join(
        root,
        "../../src/upstream/ui/lib/list/list-row-index-path.ts"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/section-list-test.ts",
    globals: false,
    imports: { "../../src/ui/lib/list/section-list": join(root, "../../src/ui/desktop/list/section-list.tsx") }
  },

  {
    file: "desktop/ui/test-token-expiration-dialog-test.ts",
    globals: false,
    imports: {
      "../../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../../src/lib/credential-sessions": join(root, "../../src/lib/credential-sessions.ts"),
      "../../../src/ui/dispatcher": join(root, "../../src/lib/account-dialog-contract.ts"),
      "../../../src/ui/preferences/test-token-expiration-dialog": join(
        root,
        "../../src/ui/preferences/test-token-expiration-dialog.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/invalidated-token-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/invalidated-token/invalidated-token": join(
        root,
        "../../src/ui/invalidated-token/invalidated-token.tsx"
      ),
      "../../../src/ui/preferences/accounts": join(root, "../../src/ui/preferences/accounts.tsx"),
      "../../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../../src/ui/dialog/dialog": join(root, "../../src/ui/desktop/dialog/dialog.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },

  {
    file: "desktop/ui/rulesets-and-publish-surfaces-test.ts",
    globals: false,
    imports: {
      "../../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../../../src/models/owner": join(root, "../../src/models/owner.ts"),
      "../../../src/ui/repository-settings/no-remote": join(root, "../../src/ui/repository-settings/no-remote.tsx"),
      "../../../src/ui/repository-rules/repo-rulesets-for-branch-link": join(
        root,
        "../../src/ui/repository-rules/repo-rulesets-for-branch-link.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/app-store-test-harness-test.ts",
    globals: false,
    imports: {
      "../helpers/app-store-test-harness": join(root, "upstream/desktop/helpers/app-store-test-harness.ts"),
      "../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../src/lib/api": join(root, "../../src/lib/api.ts")
    }
  },
  {
    file: "desktop/account-token-lifecycle-test.ts",
    globals: false,
    imports: {
      "../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../src/lib/stores/accounts-store": join(root, "../../src/lib/stores/accounts-store.ts"),
      "../../src/lib/credential-sessions": join(root, "../../src/lib/credential-sessions.ts"),
      "../../src/lib/oauth-token": join(root, "../../src/lib/oauth-token.ts"),
      "../../src/lib/account-credential": join(root, "../../src/lib/account-credential.ts"),
      "../../src/lib/auth": join(root, "../../src/lib/auth.ts"),
      "../../src/lib/api": join(root, "../../src/lib/api.ts"),
      "../helpers/mock-api": join(root, "upstream/desktop/helpers/mock-api.ts"),
      "../helpers/stores": join(root, "upstream/desktop/helpers/stores/index.ts"),
      "../../src/lib/stores/app-store": join(root, "account-actions.ts")
    }
  },
  {
    file: "desktop/branch-pruner-test.ts",
    globals: false,
    imports: {
      dugite: fixtures,
      "../../src/lib/stores/helpers/branch-pruner": join(root, "../../src/lib/stores/helpers/branch-pruner.ts"),
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../src/lib/stores/git-store-cache": join(root, "../../src/lib/stores/git-store-cache.ts"),
      "../../src/lib/stores": join(root, "../../src/lib/stores/index.ts"),
      "../../src/lib/stores/repository-state-cache": join(root, "../../src/lib/stores/repository-state-cache.ts"),
      "../helpers/repositories": fixtures,
      "../helpers/test-app-shell": join(root, "upstream/desktop/helpers/test-app-shell.ts"),
      "../helpers/databases": join(root, "upstream/desktop/helpers/databases/test-repositories-database.ts"),
      "../helpers/repository-builder-branch-pruner": join(
        root,
        "upstream/desktop/helpers/repository-builder-branch-pruner.ts"
      ),
      "../helpers/test-stats-store": join(root, "upstream/desktop/helpers/test-stats-store.ts"),
      "../../src/lib/offset-from": join(root, "../../src/upstream/lib/offset-from.ts")
    }
  },
  {
    file: "desktop/git-config-isolation-test.ts",
    globals: false,
    imports: { "../helpers/git-config": join(root, "upstream/desktop/helpers/git-config.ts") }
  },
  {
    file: "desktop/stores/updates/update-remote-url-test.ts",
    globals: false,
    imports: {
      "../../../../src/lib/stores": join(root, "../../src/lib/stores/index.ts"),
      "../../../helpers/databases": join(root, "upstream/desktop/helpers/databases/test-repositories-database.ts"),
      "../../../../src/lib/api": join(root, "../../src/lib/api.ts"),
      "../../../../src/lib/stores/updates/update-remote-url": join(
        root,
        "../../src/lib/stores/updates/update-remote-url.ts"
      ),
      "../../../helpers/test-app-shell": join(root, "upstream/desktop/helpers/test-app-shell.ts"),
      "../../../helpers/repositories": fixtures,
      "../../../../src/lib/git": join(root, "../../src/lib/desktop-git.ts"),
      "../../../helpers/test-stats-store": join(root, "upstream/desktop/helpers/test-stats-store.ts")
    }
  },
  {
    file: "desktop/git-store-cache-test.ts",
    globals: false,
    imports: {
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../src/lib/stores/git-store-cache": join(root, "../../src/lib/stores/git-store-cache.ts"),
      "../helpers/test-app-shell": join(root, "upstream/desktop/helpers/test-app-shell.ts"),
      "../helpers/test-stats-store": join(root, "upstream/desktop/helpers/test-stats-store.ts")
    }
  },
  {
    file: "desktop/git-store-test.ts",
    globals: false,
    imports: {
      dugite: fixtures,
      "../helpers/test-app-shell": join(root, "upstream/desktop/helpers/test-app-shell.ts"),
      "../helpers/repositories": fixtures,
      "../../src/lib/stores": join(root, "../../src/lib/stores/git-store.ts"),
      "../../src/models/status": join(root, "../../src/upstream/models/status.ts"),
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../src/models/tip": join(root, "../../src/models/tip.ts"),
      "../../src/lib/git": join(root, "../../src/lib/desktop-git.ts"),
      "../helpers/status": adapter,
      "../helpers/repository-scaffolding": fixtures,
      "../../src/models/branch": join(root, "../../src/models/branch.ts"),
      "../helpers/test-stats-store": join(root, "upstream/desktop/helpers/test-stats-store.ts"),
      "../helpers/git-config": join(root, "upstream/desktop/helpers/git-config.ts")
    }
  },
  {
    file: "desktop/repository-state-cache-test.ts",
    globals: false,
    imports: {
      "../../src/lib/stores/repository-state-cache": join(root, "../../src/lib/stores/repository-state-cache.ts"),
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../src/models/pull-request": join(root, "../../src/models/pull-request.ts"),
      "../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../../src/models/status": join(root, "../../src/upstream/models/status.ts"),
      "../../src/models/diff": join(root, "../../src/upstream/models/diff/index.ts"),
      "../../src/lib/app-state": join(root, "../../src/models/desktop-changes-state.ts"),
      "../helpers/github-repo-builder": join(root, "upstream/desktop/helpers/github-repo-builder.ts"),
      "../helpers/test-stats-store": join(root, "upstream/desktop/helpers/test-stats-store.ts")
    }
  },
  {
    file: "desktop/stores/updates/update-conflict-state-test.ts",
    globals: false,
    imports: {
      "../../../../src/lib/stores/updates/changes-state": join(root, "../../src/lib/stores/updates/changes-state.ts"),
      "../../../helpers/changes-state-helper": join(root, "upstream/desktop/helpers/changes-state-helper.ts"),
      "../../../../src/models/manual-conflict-resolution": join(
        root,
        "../../src/upstream/models/manual-conflict-resolution.ts"
      ),
      "../../../helpers/test-stats-store": join(root, "upstream/desktop/helpers/test-stats-store.ts")
    }
  },
  {
    file: "desktop/stores/updates/update-changed-files-test.ts",
    globals: false,
    imports: {
      "../../../../src/lib/stores/updates/changes-state": join(root, "../../src/lib/stores/updates/changes-state.ts"),
      "../../../../src/models/status": join(root, "../../src/upstream/models/status.ts"),
      "../../../../src/models/diff": join(root, "../../src/upstream/models/diff/index.ts"),
      "../../../helpers/changes-state-helper": join(root, "upstream/desktop/helpers/changes-state-helper.ts"),
      "../../../../src/lib/app-state": join(root, "../../src/models/desktop-changes-state.ts")
    }
  },
  {
    file: "desktop/script/changelog/parser-test.ts",
    globals: false,
    imports: { "../parser": join(root, "../../scripts/release/changelog-parser.ts") }
  },
  {
    file: "desktop/script/version-test.ts",
    globals: false,
    imports: { "../../../../script/draft-release/version": join(root, "../../scripts/release/version.ts") }
  },
  {
    file: "desktop/git-info-test.ts",
    globals: false,
    imports: { "../../git-info": join(root, "../../scripts/git-info.ts"), "../helpers/temp": fixtures }
  },
  { file: "desktop/welcome-test.ts", globals: false, imports: { "../../src/lib/welcome": upstream("lib/welcome.ts") } },
  {
    file: "desktop/ui/issues-autocompletion-provider-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/stores/issues-store": join(root, "../../src/lib/stores/issues-store.ts"),
      "../../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../../../src/models/owner": join(root, "../../src/models/owner.ts"),
      "../../../src/ui/autocompletion/issues-autocompletion-provider": join(
        root,
        "../../src/ui/autocompletion/issues-autocompletion-provider.tsx"
      ),
      "../../../src/ui/dispatcher": join(root, "../../src/lib/issue-dispatcher.ts"),
      "../../helpers/databases/test-issues-database": join(
        root,
        "upstream/desktop/helpers/databases/test-issues-database.ts"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx"),
      "../../helpers/ui/timers": join(root, "upstream/desktop/helpers/ui/timers.ts")
    }
  },
  {
    file: "desktop/ui/appearance-test.ts",
    globals: false,
    imports: {
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx"),
      "../../../src/ui/preferences/appearance": join(root, "../../src/ui/preferences/appearance.tsx"),
      "../../../src/ui/lib/application-theme": join(root, "../../src/lib/ui/application-theme.ts"),
      "../../../src/models/formatting-preferences": join(root, "../../src/models/formatting-preferences.ts")
    }
  },
  {
    file: "desktop/ui/ci-status-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/api": join(root, "../../src/lib/api.ts"),
      "../../../src/lib/ci-checks/ci-checks": join(root, "../../src/lib/ci-checks/ci-checks.ts"),
      "../../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../../../src/models/owner": join(root, "../../src/models/owner.ts"),
      "../../../src/ui/branches/ci-status": join(root, "../../src/ui/branches/ci-status.tsx"),
      "../../../src/ui/dispatcher": join(root, "../../src/lib/commit-status-dispatcher.ts"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx"),
      "../../helpers/ui/timers": join(root, "upstream/desktop/helpers/ui/timers.ts")
    }
  },
  {
    file: "desktop/ui/repository-list-item-test.ts",
    globals: false,
    imports: {
      "../../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../../../src/models/owner": join(root, "../../src/models/owner.ts"),
      "../../../src/ui/repositories-list/repository-list-item": join(
        root,
        "../../src/ui/repositories-list/repository-list-item.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx"),
      "../../../src/lib/fuzzy-find": join(root, "../../src/upstream/lib/fuzzy-find.ts"),
      "../../helpers/ui/timers": join(root, "upstream/desktop/helpers/ui/timers.ts")
    }
  },
  {
    file: "desktop/ui/worktree-list-item-test.ts",
    globals: false,
    imports: {
      "../../../src/models/worktree": join(root, "../../src/models/worktree.ts"),
      "../../../src/ui/worktrees/worktree-list-item": join(root, "../../src/ui/worktrees/worktree-list-item.tsx"),
      "../../../src/lib/fuzzy-find": join(root, "../../src/upstream/lib/fuzzy-find.ts"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/branch-list-item-test.ts",
    globals: false,
    imports: {
      "../../../src/models/drag-drop": join(root, "../../src/models/drag-drop.ts"),
      "../../../src/lib/drag-and-drop-manager": join(root, "../../src/lib/drag-and-drop-manager.ts"),
      "../../../src/ui/branches/branch-list-item": join(root, "../../src/ui/branches/branch-list-item.tsx"),
      "../../../src/lib/fuzzy-find": join(root, "../../src/upstream/lib/fuzzy-find.ts"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx"),
      "../../helpers/ui/timers": join(root, "upstream/desktop/helpers/ui/timers.ts")
    }
  },
  {
    file: "desktop/ui/visual-helper-surfaces-test.ts",
    globals: false,
    imports: {
      "../../../src/models/branch": join(root, "../../src/models/branch.ts"),
      "../../../src/ui/donut": join(root, "../../src/ui/donut.tsx"),
      "../../../src/ui/lib/branch-name-warnings": join(root, "../../src/ui/branches/branch-name-warnings.tsx"),
      "../../../src/ui/octicons/octicons.generated": join(root, "../../src/ui/octicons/octicons.generated.ts"),
      "../../../src/ui/octicons/octicon": join(root, "../../src/ui/octicons/octicon.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx"),
      "../../helpers/ui/timers": join(root, "upstream/desktop/helpers/ui/timers.ts")
    }
  },
  {
    file: "desktop/ui/path-and-selection-surfaces-test.ts",
    globals: false,
    imports: {
      "../../../src/models/status": join(root, "../../src/upstream/models/status.ts"),
      "../../../src/ui/changes/multiple-selection": join(root, "../../src/ui/changes/multiple-selection.tsx"),
      "../../../src/ui/lib/path-label": join(root, "../../src/ui/desktop/path-label.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/banner-surfaces-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/banners/branch-already-up-to-date-banner": join(
        root,
        "../../src/ui/banners/branch-already-up-to-date-banner.tsx"
      ),
      "../../../src/ui/banners/banner": join(root, "../../src/ui/banners/banner.tsx"),
      "../../../src/ui/banners/cherry-pick-undone": join(root, "../../src/ui/banners/cherry-pick-undone.tsx"),
      "../../../src/ui/banners/success-banner": join(root, "../../src/ui/banners/success-banner.tsx"),
      "../../helpers/ui/timers": join(root, "upstream/desktop/helpers/ui/timers.ts"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/input-description-and-textarea-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/lib/input-description/input-description": join(
        root,
        "../../src/ui/desktop/input-description/input-description.tsx"
      ),
      "../../../src/ui/lib/text-area": join(root, "../../src/ui/desktop/text-area.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/password-text-box-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/lib/password-text-box": join(root, "../../src/ui/desktop/password-text-box.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/text-box-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/octicons/octicons.generated": join(root, "../../src/ui/octicons/octicons.generated.ts"),
      "../../../src/ui/lib/text-box": join(root, "../../src/ui/desktop/text-box.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/stores/github-user-store-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/stores/github-user-store": join(root, "../../src/lib/stores/github-user-store.ts"),
      "../../../src/lib/databases/github-user-database": join(root, "../../src/lib/databases/github-user-database.ts")
    }
  },
  {
    file: "desktop/repositories-store-test.ts",
    globals: false,
    imports: {
      "../../src/lib/stores/repositories-store": join(root, "../../src/lib/stores/repositories-store.ts"),
      "../helpers/databases": join(root, "upstream/desktop/helpers/databases/test-repositories-database.ts"),
      "../../src/lib/api": join(root, "../../src/lib/api.ts"),
      "../../src/models/repository": join(root, "../../src/models/repository.ts")
    }
  },
  {
    file: "desktop/ui/stash-and-switch-branch-dialog-test.ts",
    globals: false,
    imports: {
      "../../../src/models/branch": join(root, "../../src/models/branch.ts"),
      "../../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../../src/ui/dispatcher": join(root, "../../src/lib/account-dialog-contract.ts"),
      "../../../src/ui/stash-changes/stash-and-switch-branch-dialog": join(
        root,
        "../../src/ui/stash-changes/stash-and-switch-branch-dialog.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/delete-worktree-dialogs-test.ts",
    globals: false,
    imports: {
      "../../../src/models/branch": join(root, "../../src/models/branch.ts"),
      "../../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../../src/models/worktree": join(root, "../../src/models/worktree.ts"),
      "../../../src/ui/worktrees/delete-worktree-dialog": join(
        root,
        "../../src/ui/worktrees/delete-worktree-dialog.tsx"
      ),
      "../../../src/ui/worktrees/delete-worktree-failed-dialog": join(
        root,
        "../../src/ui/worktrees/delete-worktree-failed-dialog.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/email-attribution-warning-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/api": join(root, "../../src/lib/api.ts"),
      "../../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../../src/ui/lib/git-email-not-found-warning": join(
        root,
        "../../src/ui/preferences/git-email-not-found-warning.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/copy-button-test.ts",
    globals: false,
    imports: {
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx"),
      "../../helpers/ui/electron": join(root, "upstream/desktop/helpers/ui/electron.ts"),
      "../../helpers/ui/timers": join(root, "upstream/desktop/helpers/ui/timers.ts"),
      "../../../src/ui/copy-button": join(root, "../../src/ui/copy-button.tsx")
    }
  },
  {
    file: "desktop/ui/dialog-focus-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/dialog/dialog": join(root, "../../src/ui/desktop/dialog/dialog.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/dialog-composition-and-toggle-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/dialog/default-dialog-footer": join(
        root,
        "../../src/ui/desktop/dialog/default-dialog-footer.tsx"
      ),
      "../../../src/ui/dialog/header": join(root, "../../src/ui/desktop/dialog/header.tsx"),
      "../../../src/ui/lib/call-to-action": join(root, "../../src/ui/desktop/call-to-action.tsx"),
      "../../../src/ui/lib/toggle-button": join(root, "../../src/ui/desktop/toggle-button.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/branch-empty-states-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/branches/no-branches": join(root, "../../src/ui/branches/no-branches.tsx"),
      "../../../src/ui/branches/no-pull-requests": join(root, "../../src/ui/branches/no-pull-requests.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/tab-bar-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/drag-and-drop-manager": join(root, "../../src/lib/drag-and-drop-manager.ts"),
      "../../../src/ui/tab-bar": join(root, "../../src/ui/desktop-tab-bar.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx"),
      "../../helpers/ui/timers": join(root, "upstream/desktop/helpers/ui/timers.ts")
    }
  },
  {
    file: "desktop/ui/tab-bar-item-test.ts",
    globals: false,
    imports: {
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx"),
      "../../../src/ui/tab-bar-item": join(root, "../../src/ui/tab-bar-item.tsx"),
      "../../../src/ui/tab-bar-type": join(root, "../../src/ui/tab-bar-type.ts")
    }
  },
  {
    file: "desktop/ui/relative-time-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/format-date": join(root, "../../src/lib/format-date.ts"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx"),
      "../../helpers/ui/timers": join(root, "upstream/desktop/helpers/ui/timers.ts"),
      "../../../src/ui/relative-time": join(root, "../../src/ui/relative-time.tsx")
    }
  },
  {
    file: "desktop/ui/static-status-and-link-components-test.ts",
    globals: false,
    imports: {
      "../../../src/models/computed-action": join(root, "../../src/models/computed-action.ts"),
      "../../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../../../src/models/owner": join(root, "../../src/models/owner.ts"),
      "../../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../../src/models/workflow-preferences": join(root, "../../src/upstream/models/workflow-preferences.ts"),
      "../../../src/ui/lib/action-status-icon": join(root, "../../src/ui/desktop/action-status-icon.tsx"),
      "../../../src/ui/lib/vertical-segmented-control/segmented-item": join(
        root,
        "../../src/ui/desktop/vertical-segmented-control/segmented-item.tsx"
      ),
      "../../../src/ui/repository-rules/repo-ruleset-link": join(
        root,
        "../../src/ui/repository-rules/repo-ruleset-link.tsx"
      ),
      "../../../src/ui/repository-settings/fork-contribution-target-description": join(
        root,
        "../../src/ui/repository-settings/fork-contribution-target-description.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/structural-and-text-components-test.ts",
    globals: false,
    imports: {
      "../../../src/models/avatar": join(root, "../../src/models/avatar.ts"),
      "../../../src/ui/dialog/content": join(root, "../../src/ui/desktop/dialog/content.tsx"),
      "../../../src/ui/lib/access-text": join(root, "../../src/ui/desktop/access-text.tsx"),
      "../../../src/ui/lib/commit-attribution": join(root, "../../src/ui/changes/commit-attribution.tsx"),
      "../../../src/ui/lib/form": join(root, "../../src/ui/desktop/form.tsx"),
      "../../../src/ui/lib/highlight-text": join(root, "../../src/ui/desktop/highlight-text.tsx"),
      "../../../src/ui/ui-view": join(root, "../../src/ui/ui-view.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/layout-and-message-components-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/changes/commit-warning": join(root, "../../src/ui/changes/commit-warning.tsx"),
      "../../../src/ui/keyboard-shortcut/keyboard-shortcut": join(
        root,
        "../../src/ui/keyboard-shortcut/keyboard-shortcut.tsx"
      ),
      "../../../src/ui/lib/errors": join(root, "../../src/ui/desktop/errors.tsx"),
      "../../../src/ui/lib/row": join(root, "../../src/ui/desktop/row.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/aria-live-container-test.ts",
    globals: false,
    imports: {
      "../../helpers/ui/timers": join(root, "upstream/desktop/helpers/ui/timers.ts"),
      "../../../src/ui/accessibility/aria-live-container": join(
        root,
        "../../src/ui/accessibility/aria-live-container.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/dialog-and-input-description-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/dialog/error": join(root, "../../src/ui/desktop/dialog/error.tsx"),
      "../../../src/ui/dialog/success": join(root, "../../src/ui/desktop/dialog/success.tsx"),
      "../../../src/ui/lib/input-description/input-caption": join(
        root,
        "../../src/ui/desktop/input-description/input-caption.tsx"
      ),
      "../../../src/ui/lib/input-description/input-error": join(
        root,
        "../../src/ui/desktop/input-description/input-error.tsx"
      ),
      "../../../src/ui/lib/input-description/input-warning": join(
        root,
        "../../src/ui/desktop/input-description/input-warning.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/dialog-action-wrappers-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/dialog/content": join(root, "../../src/ui/desktop/dialog/content.tsx"),
      "../../../src/ui/dialog/footer": join(root, "../../src/ui/desktop/dialog/footer.tsx"),
      "../../../src/ui/dialog/ok-cancel-button-group": join(
        root,
        "../../src/ui/desktop/dialog/ok-cancel-button-group.tsx"
      ),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/control-primitives-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/lib/button": join(root, "../../src/ui/desktop/button.tsx"),
      "../../../src/ui/lib/checkbox": join(root, "../../src/ui/desktop/checkbox.tsx"),
      "../../../src/ui/lib/radio-button": join(root, "../../src/ui/desktop/radio-button.tsx"),
      "../../../src/ui/lib/radio-group": join(root, "../../src/ui/desktop/radio-group.tsx"),
      "../../../src/ui/lib/select": join(root, "../../src/ui/desktop/select.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/component-primitives-test.ts",
    globals: false,
    imports: {
      "../../../src/ui/changes/files-changed-badge": join(root, "../../src/ui/changes/files-changed-badge.tsx"),
      "../../../src/ui/dialog/footer": join(root, "../../src/ui/desktop/dialog/footer.tsx"),
      "../../../src/ui/lib/horizontal-rule": join(root, "../../src/ui/desktop/horizontal-rule.tsx"),
      "../../../src/ui/lib/loading": join(root, "../../src/ui/desktop/loading.tsx"),
      "../../../src/ui/lib/ref": join(root, "../../src/ui/desktop/ref.tsx"),
      "../../../src/ui/toolbar/toolbar": join(root, "../../src/ui/toolbar/desktop-toolbar.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/ui/path-text-and-link-button-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/app-shell": join(root, "../../src/lib/app-shell.ts"),
      "../../../src/ui/lib/link-button": join(root, "../../src/ui/desktop/link-button.tsx"),
      "../../../src/ui/lib/path-text": join(root, "../../src/ui/desktop/path-text.tsx"),
      "../../helpers/ui/render": join(root, "upstream/desktop/helpers/ui/render.tsx")
    }
  },
  {
    file: "desktop/octicon-test.ts",
    globals: false,
    imports: {
      "../../src/ui/octicons": join(root, "../../src/ui/octicons/index.ts"),
      "../../src/ui/octicons/octicons.generated": join(root, "../../src/ui/octicons/octicons.generated.ts"),
      "../../src/models/cloning-repository": join(root, "../../src/models/cloning-repository.ts"),
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../helpers/github-repo-builder": join(root, "upstream/desktop/helpers/github-repo-builder.ts")
    }
  },
  {
    file: "desktop/path-text-test.ts",
    globals: false,
    imports: { "../../src/ui/lib/path-text": join(root, "../../src/ui/desktop/path-text.tsx") }
  },
  {
    file: "desktop/dds-converter-test.ts",
    globals: false,
    imports: { "../../src/ui/diff/image-diffs/dds-converter": upstream("ui/diff/image-diffs/dds-converter.ts") }
  },
  {
    file: "desktop/ahead-behind-store-test.ts",
    globals: false,
    imports: {
      "../../src/lib/stores/ahead-behind-store": join(root, "../../src/lib/stores/ahead-behind-store.ts"),
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../src/models/branch": join(root, "../../src/models/branch.ts"),
      "../helpers/repositories": fixtures,
      "../helpers/repository-scaffolding": fixtures,
      dugite: fixtures
    }
  },
  {
    file: "desktop/cloning-repositories-store-test.ts",
    globals: false,
    imports: {
      "../../src/lib/stores/cloning-repositories-store": join(
        root,
        "../../src/lib/stores/cloning-repositories-store.ts"
      ),
      "../../src/models/cloning-repository": join(root, "../../src/models/cloning-repository.ts")
    }
  },
  {
    file: "desktop/mock-api-test.ts",
    globals: false,
    imports: { "../helpers/mock-api": join(root, "upstream/desktop/helpers/mock-api.ts") }
  },
  {
    file: "desktop/oauth-authentication-test.ts",
    globals: false,
    imports: {
      "../../src/lib/api": join(root, "../../src/lib/api.ts"),
      "../../src/lib/oauth-token": join(root, "../../src/lib/oauth-token.ts"),
      "../../src/lib/app-shell": join(root, "../../src/lib/app-shell.ts"),
      "../../src/lib/stores/accounts-store": join(root, "../../src/lib/stores/accounts-store.ts"),
      "../../src/lib/stores/sign-in-store": join(root, "../../src/lib/stores/sign-in-store.ts"),
      "../../src/models/account": join(root, "../../src/models/account.ts"),
      "../helpers/stores": join(root, "upstream/desktop/helpers/stores/index.ts")
    }
  },
  {
    file: "desktop/sign-in-store-test.ts",
    globals: false,
    imports: {
      "../../src/lib/stores/sign-in-store": join(root, "../../src/lib/stores/sign-in-store.ts"),
      "../../src/lib/stores": join(root, "../../src/lib/stores/accounts-store.ts"),
      "../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../src/lib/api": join(root, "../../src/lib/api.ts"),
      "../helpers/stores": join(root, "upstream/desktop/helpers/stores/index.ts")
    }
  },
  {
    file: "desktop/credential-sessions-test.ts",
    globals: false,
    imports: {
      "../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../src/lib/credential-sessions": join(root, "../../src/lib/credential-sessions.ts"),
      "../../src/lib/oauth-token": join(root, "../../src/lib/oauth-token.ts"),
      "../../src/lib/account-credential": join(root, "../../src/lib/account-credential.ts"),
      "../../src/lib/auth": join(root, "../../src/lib/auth.ts"),
      "../helpers/stores": join(root, "upstream/desktop/helpers/stores/index.ts")
    }
  },
  {
    file: "desktop/accounts-store-test.ts",
    globals: false,
    imports: {
      "../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../src/lib/stores": join(root, "../../src/lib/stores/accounts-store.ts"),
      "../helpers/stores": join(root, "upstream/desktop/helpers/stores/index.ts"),
      "../../src/lib/credential-sessions": join(root, "../../src/lib/credential-sessions.ts"),
      "../../src/lib/oauth-token": join(root, "../../src/lib/oauth-token.ts")
    }
  },
  {
    file: "desktop/release-notes-test.ts",
    globals: false,
    imports: { "../../src/lib/release-notes": join(root, "../../src/lib/release-notes.ts") }
  },
  {
    file: "desktop/parse-app-url-test.ts",
    globals: false,
    imports: { "../../src/lib/parse-app-url": join(root, "../../src/lib/parse-app-url.ts") }
  },
  {
    file: "desktop/find-account-test.ts",
    globals: false,
    imports: {
      "../../src/lib/api": join(root, "../../src/lib/api.ts"),
      "../../src/lib/find-account": join(root, "../../src/lib/find-account.ts"),
      "../../src/models/account": join(root, "../../src/models/account.ts")
    }
  },
  {
    file: "desktop/ci-checks-test.ts",
    globals: false,
    imports: {
      "../../src/lib/api": join(root, "../../src/lib/api.ts"),
      "../../src/lib/ci-checks/ci-checks": join(root, "../../src/lib/ci-checks/ci-checks.ts")
    }
  },
  {
    file: "desktop/api-test.ts",
    globals: false,
    imports: {
      "../../src/lib/api": join(root, "../../src/lib/api.ts")
    }
  },
  {
    file: "desktop/short-lived-token-rollout-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../src/lib/feature-flag": join(root, "../../src/lib/desktop-features.ts"),
      "../../src/ui/lib/app-proxy": join(root, "../../src/lib/app-version.ts"),
      "../../src/lib/short-lived-token-rollout": join(root, "../../src/lib/short-lived-token-rollout.ts")
    }
  },
  { file: "desktop/status-parser-test.ts", globals: false, imports: { "../../src/lib/status-parser": adapter } },
  {
    file: "desktop/squirrel-error-parser-test.ts",
    globals: false,
    imports: { "../../src/lib/squirrel-error-parser": join(root, "../../src/upstream/lib/squirrel-error-parser.ts") }
  },
  {
    file: "desktop/wrap-rich-text-commit-message-test.ts",
    globals: false,
    imports: {
      "../../src/lib/wrap-rich-text-commit-message": join(root, "../../src/lib/wrap-rich-text-commit-message.ts"),
      "../../src/lib/text-token-parser": join(root, "../../src/lib/text-token-parser.ts"),
      "../helpers/github-repo-builder": join(root, "upstream/desktop/helpers/github-repo-builder.ts"),
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../src/lib/emoji": join(root, "../../src/upstream/lib/emoji.ts")
    }
  },
  {
    file: "desktop/text-token-parser-test.ts",
    globals: false,
    imports: {
      "../../src/lib/emoji": join(root, "../../src/upstream/lib/emoji.ts"),
      "../../src/lib/text-token-parser": join(root, "../../src/lib/text-token-parser.ts"),
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../helpers/github-repo-builder": join(root, "upstream/desktop/helpers/github-repo-builder.ts")
    }
  },
  {
    file: "desktop/repo-rules-test.ts",
    globals: false,
    imports: {
      "../../src/lib/api": join(root, "../../src/lib/api-rule-types.ts"),
      "../../src/lib/helpers/repo-rules": join(root, "../../src/lib/repo-rules.ts"),
      "../../src/models/repo-rules": join(root, "../../src/upstream/models/repo-rules.ts"),
      "../../src/models/repository": join(root, "../../src/models/repository.ts")
    }
  },

  {
    file: "desktop/repositories-clone-grouping-test.ts",
    globals: false,
    imports: {
      "../../src/ui/clone-repository/group-repositories": join(root, "../../src/lib/repository-clone-grouping.ts"),
      "../../src/lib/api": join(root, "../../src/lib/api-repository-types.ts")
    }
  },
  {
    file: "desktop/repositories-list-grouping-test.ts",
    globals: false,
    imports: {
      "../../src/ui/repositories-list/group-repositories": join(root, "../../src/lib/repository-list-grouping.ts"),
      "../helpers/github-repo-builder": join(root, "upstream/desktop/helpers/github-repo-builder.ts"),
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../src/models/cloning-repository": join(root, "../../src/models/cloning-repository.ts")
    }
  },
  {
    file: "desktop/group-branches-test.ts",
    globals: false,
    imports: {
      "../../src/ui/branches": join(root, "../../src/lib/group-branches.ts"),
      "../../src/models/branch": join(root, "../../src/models/branch.ts"),
      "../../src/models/commit-identity": upstream("models/commit-identity.ts")
    }
  },
  {
    file: "desktop/find-forked-remotes-to-prune-test.ts",
    globals: false,
    imports: {
      "../../src/lib/stores/helpers/find-forked-remotes-to-prune": join(
        root,
        "../../src/lib/find-forked-remotes-to-prune.ts"
      ),
      "../../src/models/branch": join(root, "../../src/models/branch.ts"),
      "../../src/models/commit-identity": upstream("models/commit-identity.ts"),
      "../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../../src/models/pull-request": join(root, "../../src/models/pull-request.ts"),
      "../../src/models/remote": upstream("models/remote.ts"),
      "../helpers/github-repo-builder": join(root, "upstream/desktop/helpers/github-repo-builder.ts")
    }
  },
  {
    file: "desktop/find-upstream-remote-test.ts",
    globals: false,
    imports: {
      "../../src/lib/stores/helpers/find-upstream-remote": join(root, "../../src/lib/find-upstream-remote.ts"),
      "../helpers/github-repo-builder": join(root, "upstream/desktop/helpers/github-repo-builder.ts")
    }
  },
  {
    file: "desktop/repository-matching-test.ts",
    globals: false,
    imports: {
      "../../src/lib/repository-matching": join(root, "../../src/lib/repository-matching.ts"),
      "../../src/models/account": join(root, "../../src/models/account.ts"),
      "../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../helpers/github-repo-builder": join(root, "upstream/desktop/helpers/github-repo-builder.ts")
    }
  },
  {
    file: "desktop/model-worktree-test.ts",
    globals: false,
    imports: { "../../src/models/worktree": join(root, "../../src/models/worktree.ts") }
  },
  {
    file: "desktop/cloning-repository-test.ts",
    globals: false,
    imports: { "../../src/models/cloning-repository": join(root, "../../src/models/cloning-repository.ts") }
  },
  {
    file: "desktop/model-type-guards-test.ts",
    globals: false,
    imports: {
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../../src/models/owner": join(root, "../../src/models/owner.ts")
    }
  },
  {
    file: "desktop/name-of-test.ts",
    globals: false,
    imports: {
      "../../src/models/repository": join(root, "../../src/models/repository.ts"),
      "../helpers/github-repo-builder": join(root, "upstream/desktop/helpers/github-repo-builder.ts")
    }
  },
  {
    file: "desktop/repository-test.ts",
    globals: false,
    imports: { "../../src/models/repository": join(root, "../../src/models/repository.ts") }
  },
  {
    file: "desktop/api-error-handling-test.ts",
    globals: false,
    imports: { "../../src/lib/http": join(root, "../../src/lib/http.ts") }
  },
  {
    file: "desktop/oauth-token-test.ts",
    globals: false,
    imports: {
      "../../src/lib/http": join(root, "../../src/lib/http.ts"),
      "../../src/lib/oauth-token": join(root, "../../src/lib/oauth-token.ts")
    }
  },

  {
    file: "desktop/create-branch-test.ts",
    globals: false,
    imports: {
      "../../src/lib/create-branch": join(root, "../../src/lib/create-branch.ts"),
      "../../src/models/tip": join(root, "../../src/models/tip.ts"),
      "../../src/models/branch": join(root, "../../src/models/branch.ts")
    }
  },
  {
    file: "desktop/fuzzy-find-test.ts",
    globals: false,
    imports: {
      "../../src/lib/fuzzy-find": upstream("lib/fuzzy-find.ts"),
      "../../src/ui/lib/filter-list": join(root, "../../src/lib/filter-list.ts")
    }
  },
  {
    file: "desktop/endpoint-capabilities-test.ts",
    globals: false,
    imports: {
      "../../src/lib/endpoint-capabilities": join(root, "../../src/lib/endpoint-capabilities.ts"),
      semver: join(root, "../../node_modules/semver/index.js"),
      "../../src/lib/api": join(root, "../../src/lib/desktop-api-urls.ts"),
      "../../src/lib/fatal-error": upstream("lib/fatal-error.ts")
    }
  },
  {
    file: "desktop/email-test.ts",
    globals: false,
    imports: {
      "../../src/lib/email": join(root, "../../src/lib/email.ts"),
      "../../src/lib/api": join(root, "../../src/lib/desktop-api-urls.ts"),
      "../../src/models/account": join(root, "../../src/models/account.ts")
    }
  },
  {
    file: "desktop/pull-request-refs-test.ts",
    globals: false,
    imports: {
      "../../src/models/commit": join(root, "../../src/models/commit.ts"),
      "../../src/models/commit-identity": upstream("models/commit-identity.ts"),
      "../../src/models/pull-request": join(root, "../../src/models/pull-request.ts"),
      "../../src/models/github-repository": join(root, "../../src/models/github-repository.ts"),
      "../../src/models/owner": join(root, "../../src/models/owner.ts"),
      "../../src/lib/pull-request-refs": join(root, "../../src/lib/pull-request-refs.ts")
    }
  },
  {
    file: "desktop/squashed-commit-description-test.ts",
    globals: false,
    imports: {
      "../../src/models/commit": join(root, "../../src/models/commit.ts"),
      "../../src/models/commit-identity": upstream("models/commit-identity.ts"),
      "../../src/lib/git": adapter,
      "../../src/lib/squash/squashed-commit-description": join(root, "../../src/lib/squashed-commit-description.ts")
    }
  },
  {
    file: "desktop/unique-coauthors-as-authors-test.ts",
    globals: false,
    imports: {
      "../../src/models/commit": join(root, "../../src/models/commit.ts"),
      "../../src/models/commit-identity": upstream("models/commit-identity.ts"),
      "../../src/lib/git": adapter,
      "../../src/lib/unique-coauthors-as-authors": join(root, "../../src/lib/unique-coauthors-as-authors.ts")
    }
  },
  {
    file: "desktop/multi-operation-terminal-output-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git/multi-operation-terminal-output": join(
        root,
        "../../src/lib/multi-operation-terminal-output.ts"
      ),
      "../../../src/lib/git": adapter
    }
  },
  {
    file: "desktop/push-terminal-chunk-test.ts",
    globals: false,
    imports: { "../../../src/lib/git/push-terminal-chunk": join(root, "../../src/lib/terminal-chunks.ts") }
  },
  {
    file: "desktop/create-tail-stream-test.ts",
    globals: false,
    imports: { "../../../src/lib/git/create-tail-stream": join(root, "terminal.ts") }
  },
  {
    file: "desktop/create-terminal-stream-test.ts",
    globals: false,
    imports: { "../../../src/lib/create-terminal-stream": join(root, "terminal.ts"), "../../helpers/fixture": fixtures }
  },
  {
    file: "desktop/enterprise-validate-url-test.ts",
    globals: false,
    imports: { "../../src/ui/lib/enterprise-validate-url": join(root, "../../src/lib/enterprise-validate-url.ts") }
  },
  {
    file: "desktop/parse-pac-string-test.ts",
    globals: false,
    imports: { "../../src/lib/parse-pac-string": upstream("lib/parse-pac-string.ts") }
  },
  { file: "desktop/ssh-test.ts", globals: false, imports: { "../../src/lib/ssh/ssh": adapter } },
  {
    file: "desktop/http-test.ts",
    globals: false,
    imports: { "../../src/lib/http": adapter, "../../src/lib/api": adapter }
  },
  { file: "desktop/format-test.ts", globals: false, imports: { "../../src/lib/rebase": adapter } },
  {
    file: "desktop/file-system-test.ts",
    globals: false,
    imports: { "../../src/lib/file-system": adapter, "../helpers/temp": fixtures }
  },
  { file: "desktop/credential-test.ts", globals: false, imports: { "../../../src/lib/git/credential": adapter } },
  {
    file: "desktop/local-storage-test.ts",
    globals: false,
    imports: { "../../src/lib/local-storage": upstream("lib/local-storage.ts") }
  },
  {
    file: "desktop/parse-files-to-be-overwritten-test.ts",
    globals: false,
    imports: {
      "../../src/lib/git": adapter,
      dugite: fixtures,
      "../helpers/repositories": fixtures,
      "../helpers/repository-scaffolding": fixtures,
      "../../src/ui/lib/parse-files-to-be-overwritten": upstream("ui/lib/parse-files-to-be-overwritten.ts")
    }
  },
  {
    file: "desktop/core-test.ts",
    globals: false,
    imports: { "../../../src/lib/git": adapter, dugite: fixtures, "../../helpers/repositories": fixtures }
  },
  {
    file: "desktop/remote-operations-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git/core": adapter,
      "../../../src/lib/git/fetch": adapter,
      "../../../src/lib/git/pull": adapter,
      "../../../src/lib/git/push": adapter,
      "../../../src/lib/git/merge": adapter,
      "../../../src/lib/git/branch": adapter,
      "../../../src/lib/git/for-each-ref": adapter,
      "../../../src/lib/git/rebase": adapter,
      "../../../src/lib/git/checkout": adapter,
      "../../../src/lib/git/worktree": adapter,
      "../../../src/lib/git/tag": adapter,
      "../../helpers/repositories": fixtures,
      "../../helpers/temp": fixtures,
      "../../helpers/git-config": fixtures,
      "../../helpers/repository-scaffolding": fixtures,
      "../../helpers/git": adapter
    }
  },
  { file: "desktop/get-file-hash-test.ts", globals: false, imports: { "../../src/lib/get-file-hash": adapter } },
  { file: "desktop/path-test.ts", globals: false, imports: { "../../src/lib/path": adapter } },
  {
    file: "desktop/is-application-bundle-test.ts",
    globals: false,
    imports: { "../../src/lib/is-application-bundle": adapter }
  },
  {
    file: "desktop/format-commit-message-test.ts",
    globals: false,
    imports: { "../../src/lib/format-commit-message": adapter, "../helpers/repositories": fixtures }
  },
  {
    file: "desktop/write-default-readme-test.ts",
    globals: false,
    imports: { "../../src/ui/add-repository/write-default-readme": adapter, "../helpers/temp": fixtures }
  },
  {
    file: "desktop/format-number-test.ts",
    globals: false,
    imports: {
      "../../src/lib/format-number": join(root, "../../src/lib/format-number.ts"),
      "../../src/models/formatting-preferences": join(root, "../../src/models/formatting-preferences.ts")
    }
  },
  {
    file: "desktop/bytes-test.ts",
    globals: false,
    imports: { "../../src/ui/lib/bytes": join(root, "../../src/lib/format-bytes.ts") }
  },
  ...["git", "clone", "lfs"].map(name => ({
    file: `desktop/progress/${name}-test.ts`,
    globals: false,
    imports: Object.fromEntries(
      (name === "git"
        ? ["../../../src/lib/progress", "../../../src/lib/progress/git"]
        : [name === "lfs" ? "../../../src/lib/progress/lfs" : "../../../src/lib/progress"]
      ).map(path => [path, adapter])
    )
  })),
  { file: "desktop/enum-test.ts", globals: false, imports: { "../../src/lib/enum": upstream("lib/enum.ts") } },
  {
    file: "desktop/fatal-error-test.ts",
    globals: false,
    imports: { "../../src/lib/fatal-error": upstream("lib/fatal-error.ts") }
  },
  {
    file: "desktop/is-record-test.ts",
    globals: false,
    imports: { "../../src/lib/is-record": upstream("lib/is-record.ts") }
  },
  {
    file: "desktop/truncate-with-ellipsis-test.ts",
    globals: false,
    imports: { "../../src/lib/truncate-with-ellipsis": upstream("lib/truncate-with-ellipsis.ts") }
  },
  {
    file: "desktop/sanitize-ref-name-test.ts",
    globals: false,
    imports: { "../../src/lib/sanitize-ref-name": upstream("lib/sanitize-ref-name.ts") }
  },
  {
    file: "desktop/format-duration-test.ts",
    globals: false,
    imports: { "../../src/lib/format-duration": upstream("lib/format-duration.ts") }
  },
  {
    file: "desktop/remove-remote-prefix-test.ts",
    globals: false,
    imports: { "../../src/lib/remove-remote-prefix": upstream("lib/remove-remote-prefix.ts") }
  },
  { file: "desktop/promise-test.ts", globals: false, imports: { "../../src/lib/promise": upstream("lib/promise.ts") } },
  {
    file: "desktop/promise-with-timeout-test.ts",
    globals: false,
    imports: { "../../src/lib/promise": upstream("lib/promise.ts") }
  },
  {
    file: "desktop/offset-from-test.ts",
    globals: false,
    imports: { "../../src/lib/offset-from": upstream("lib/offset-from.ts") }
  },
  {
    file: "desktop/worktree-dropdown-test.ts",
    globals: false,
    imports: { "../../src/lib/worktree-dropdown": upstream("lib/worktree-dropdown.ts") }
  },
  { file: "desktop/round-test.ts", globals: false, imports: { "../../src/ui/lib/round": upstream("ui/lib/round.ts") } },
  {
    file: "desktop/identifier-rules-test.ts",
    globals: false,
    imports: { "../../src/ui/lib/identifier-rules": upstream("ui/lib/identifier-rules.ts") }
  },
  {
    file: "desktop/list-selection-test.ts",
    globals: false,
    imports: { "../../src/ui/lib/list/selection": upstream("ui/lib/list/selection.ts") }
  },
  {
    file: "desktop/section-list-selection-test.ts",
    globals: false,
    imports: {
      "../../src/ui/lib/list/section-list-selection": upstream("ui/lib/list/section-list-selection.ts"),
      "../../src/ui/lib/list/list-row-index-path": upstream("ui/lib/list/list-row-index-path.ts")
    }
  },
  {
    file: "desktop/commit-identity-test.ts",
    globals: false,
    imports: { "../../src/models/commit-identity": upstream("models/commit-identity.ts") }
  },
  {
    file: "desktop/sanitized-repository-name-test.ts",
    globals: false,
    imports: {
      "../../src/ui/add-repository/sanitized-repository-name": upstream(
        "ui/add-repository/sanitized-repository-name.ts"
      )
    }
  },
  {
    file: "desktop/clone-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git/clone": adapter,
      "../../../src/lib/git": adapter,
      "../../../src/lib/git/core": adapter,
      "../../helpers/repositories": fixtures,
      "../../helpers/repository-scaffolding": fixtures,
      "../../helpers/temp": fixtures,
      dugite: fixtures
    }
  },
  {
    file: "desktop/remote-test.ts",
    globals: false,
    imports: {
      "../../../src/models/repository": fixtures,
      "../../../src/lib/git/remote": adapter,
      "../../../src/lib/git": adapter,
      "../../helpers/repositories": fixtures,
      "../../helpers/git-config": fixtures,
      dugite: fixtures,
      "../../../src/lib/stores/helpers/find-default-remote": join(root, "upstream/desktop/find-default-remote.ts")
    }
  },
  {
    file: "desktop/git-attributes-test.ts",
    globals: false,
    imports: {
      "../../helpers/repositories": fixtures,
      "../../../src/ui/add-repository/git-attributes": adapter
    }
  },
  {
    file: "desktop/cherry-pick-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git": adapter,
      "../../../src/lib/git/cherry-pick": adapter,
      "../../../src/lib/status": adapter,
      "../../../src/models/manual-conflict-resolution": adapter,
      "../../../src/models/repository": fixtures,
      "../../../src/models/status": upstream("models/status.ts"),
      "../../helpers/git": adapter,
      "../../helpers/status": adapter,
      "../../helpers/repository-scaffolding": fixtures,
      dugite: fixtures,
      "../../helpers/repository-builder-cherry-pick-test": join(
        root,
        "upstream/desktop/helpers/repository-builder-cherry-pick-test.ts"
      )
    }
  },
  {
    file: "desktop/rebase-full-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git/rebase": adapter,
      "../../../src/lib/git": adapter,
      "../../helpers/repositories": fixtures,
      "../../helpers/repository-scaffolding": fixtures,
      "../../../src/models/branch": adapter,
      "../../helpers/status": adapter
    }
  },
  ...["detect-conflict", "progress"].map(name => ({
    file: `desktop/rebase/${name}-test.ts`,
    globals: false,
    imports: Object.fromEntries([
      ["../../../../src/lib/git", adapter],
      ["../../../helpers/status", adapter],
      ["../../../helpers/git", adapter],
      [
        "../../../helpers/repository-builder-rebase-test",
        join(root, "upstream/desktop/helpers/repository-builder-rebase-test.ts")
      ],
      ...(name === "detect-conflict"
        ? [
            ["dugite", fixtures],
            ["../../../../src/lib/git/rebase", adapter],
            ["../../../../src/models/status", upstream("models/status.ts")]
          ]
        : [
            ["../../../helpers/repositories", fixtures],
            ["../../../../src/lib/status", adapter],
            ["../../../../src/models/manual-conflict-resolution", adapter],
            ["../../../../src/models/repository", fixtures],
            [
              "../../../helpers/repository-builder-long-rebase-test",
              join(root, "upstream/desktop/helpers/repository-builder-long-rebase-test.ts")
            ]
          ])
    ])
  })),
  {
    file: "desktop/diff-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git": adapter,
      "../../../src/models/repository": fixtures,
      "../../../src/models/status": upstream("models/status.ts"),
      "../../../src/models/diff": upstream("models/diff/index.ts"),
      "../../helpers/repositories": fixtures,
      "../../helpers/status": adapter,
      "../../helpers/repository-scaffolding": fixtures,
      dugite: fixtures
    }
  },
  {
    file: "desktop/revision-consumers-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git/diff": adapter,
      "../../../src/lib/git/log": adapter,
      "../../../src/lib/git/show": adapter,
      "../../../src/lib/git/rev-list": adapter,
      "../../../src/models/repository": fixtures,
      "../../../src/models/status": upstream("models/status.ts"),
      "../../../src/models/diff": upstream("models/diff/index.ts"),
      "../../helpers/repositories": fixtures,
      "../../helpers/repository-scaffolding": fixtures,
      dugite: fixtures
    }
  },
  ...["only-ahead", "only-behind", "ahead-and-behind", "pull"].map(name => ({
    file: `desktop/pull/${name}-test.ts`,
    globals: false,
    imports: Object.fromEntries([
      ["../../../../src/lib/git", adapter],
      ["../../../helpers/repository-scaffolding", fixtures],
      ...(name === "pull"
        ? [
            ["../../../helpers/repositories", fixtures],
            ["../../../../src/models/repository", fixtures],
            ["dugite", fixtures]
          ]
        : [
            ["../../../helpers/repository-builder-pull-test", fixtures],
            ["../../../helpers/git", adapter],
            ["../../../helpers/local-config", fixtures]
          ])
    ])
  })),
  {
    file: "desktop/stash-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git/stash": adapter,
      "../../../src/models/repository": fixtures,
      "../../helpers/repositories": fixtures,
      "../../helpers/status": adapter,
      "../../../src/models/status": upstream("models/status.ts"),
      "../../../src/models/stash-entry": adapter,
      "../../helpers/random-data": join(root, "upstream/desktop/random-data.ts"),
      dugite: fixtures
    }
  },
  {
    file: "desktop/push-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git/push": adapter,
      "../../../src/models/repository": fixtures,
      "../../helpers/repositories": fixtures,
      "../../helpers/repository-scaffolding": fixtures,
      "../../helpers/temp": fixtures,
      dugite: fixtures
    }
  },
  {
    file: "desktop/log-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git": adapter,
      "../../../src/models/repository": fixtures,
      "../../helpers/repositories": fixtures,
      "../../helpers/local-config": fixtures,
      "../../../src/models/status": upstream("models/status.ts")
    }
  },
  ...["fetch", "lfs", "status"].map(name => ({
    file: `desktop/${name}-test.ts`,
    globals: false,
    imports: Object.fromEntries([
      ["../../../src/models/repository", fixtures],
      ["../../helpers/repositories", fixtures],
      ...(name !== "fetch" ? [["dugite", fixtures]] : []),
      ...(name !== "lfs" ? [["../../../src/lib/git", adapter]] : []),
      ...(name === "fetch"
        ? [
            ["../../../src/lib/git/for-each-ref", adapter],
            ["../../../src/models/branch", adapter]
          ]
        : []),
      ...(name === "lfs" ? [["../../../src/lib/git/lfs", adapter]] : []),
      ...(name === "status"
        ? [
            ["../../helpers/status", adapter],
            ["../../../src/models/status", upstream("models/status.ts")],
            ["../../../src/lib/status", upstream("lib/status.ts")],
            ["../../helpers/local-config", fixtures],
            ["../../helpers/random-data", join(root, "upstream/desktop/random-data.ts")]
          ]
        : [])
    ])
  })),
  ...["description", "reflog", "submodule", "format-patch"].map(name => ({
    file: `desktop/${name}-test.ts`,
    globals: false,
    imports: Object.fromEntries([
      ["../../../src/lib/git", adapter],
      ["../../helpers/repositories", fixtures],
      ...(name !== "description" ? [["../../../src/models/repository", fixtures]] : []),
      ...(["reflog", "format-patch"].includes(name) ? [["dugite", fixtures]] : []),
      ...(name === "reflog" ? [["../../../src/lib/offset-from", upstream("lib/offset-from.ts")]] : []),
      ...(name === "submodule" ? [["../../../src/lib/git/submodule", adapter]] : []),
      ...(name === "format-patch" ? [["../../helpers/repository-scaffolding", fixtures]] : [])
    ])
  })),
  {
    file: "desktop/worktree-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git": adapter,
      "../../../src/models/repository": fixtures,
      "../../helpers/repositories": fixtures,
      "../../helpers/repository-scaffolding": fixtures,
      dugite: fixtures
    }
  },
  {
    file: "desktop/worktree-move-test.ts",
    unbundled: true,
    globals: false,
    imports: {
      "../../../src/lib/path-exists": fixtures,
      "../../../src/models/repository": fixtures,
      "../../../src/lib/git/worktree": adapter,
      "../../helpers/repositories": fixtures,
      "../../helpers/repository-scaffolding": fixtures,
      dugite: fixtures
    },
    // The suite wraps its own dugite instance; production (the adapter) runs
    // the move through the mocked transport so the recorded cwd is observed.
    mocks: { dugite: join(root, "git-process.ts") }
  },
  {
    file: "desktop/tag-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git": adapter,
      "../../../src/models/repository": fixtures,
      "../../helpers/repositories": fixtures,
      "../../helpers/status": adapter,
      "../../../src/lib/fatal-error": upstream("lib/fatal-error.ts"),
      "../../../src/lib/stores/helpers/find-default-remote": join(root, "upstream/desktop/find-default-remote.ts")
    }
  },
  ...["add", "apply", "reset", "diff-stage", "diff-resolution"].map(name => ({
    file: `desktop/${name}-test.ts`,
    globals: false,
    imports: Object.fromEntries([
      ["../../helpers/repositories", fixtures],
      ...(name === "add" ? [["../../../src/lib/git/add", adapter]] : []),
      ...(name === "reset" ? [["../../../src/lib/git/reset", adapter]] : []),
      ...(["apply", "diff-stage", "diff-resolution"].includes(name)
        ? [
            ["../../../src/lib/git", adapter],
            ["../../../src/models/diff", upstream("models/diff/index.ts")]
          ]
        : []),
      ...(["add", "apply"].includes(name) ? [["../../../src/models/status", upstream("models/status.ts")]] : []),
      ...(["add", "reset"].includes(name) ? [["../../helpers/status", adapter]] : []),
      ...(["apply", "reset"].includes(name) ? [["../../../src/models/repository", fixtures]] : []),
      ...(["reset", "diff-stage"].includes(name) ? [["dugite", fixtures]] : []),
      ...(["diff-stage", "diff-resolution"].includes(name) ? [["../../helpers/repository-scaffolding", fixtures]] : []),
      ...(name === "apply"
        ? [
            ["../../../src/ui/diff/diff-explorer", upstream("ui/diff/diff-explorer.ts")],
            ["diff", join(root, "../../node_modules/diff/libesm/index.js")]
          ]
        : [])
    ])
  })),
  { file: "desktop/remote-parsing-test.ts", globals: false, imports: { "../../src/lib/remote-parsing": adapter } },
  {
    file: "desktop/clone-path-safety-test.ts",
    globals: false,
    imports: { "../../src/lib/remote-parsing": upstream("lib/remote-parsing.ts") }
  },
  {
    file: "desktop/status-utils-test.ts",
    globals: false,
    imports: {
      "../../src/lib/status": upstream("lib/status.ts"),
      "../../src/models/status": upstream("models/status.ts"),
      "../../src/models/diff": upstream("models/diff/index.ts")
    }
  },
  {
    file: "desktop/commit-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git": adapter,
      "../../helpers/repositories": fixtures,
      "../../../src/models/repository": fixtures,
      "../../../src/models/status": upstream("models/status.ts"),
      "../../../src/models/diff": upstream("models/diff/index.ts"),
      "../../helpers/status": adapter,
      "../../../src/models/manual-conflict-resolution": adapter,
      "../../../src/lib/status": adapter,
      "../../../src/lib/path-exists": fixtures,
      dugite: fixtures
    }
  },
  {
    file: "desktop/for-each-ref-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git/for-each-ref": adapter,
      "../../helpers/repositories": fixtures,
      "../../../src/models/repository": fixtures,
      "../../../src/models/branch": adapter
    }
  },
  {
    file: "desktop/log-revision-exclusions-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git/log": adapter,
      "../../helpers/repositories": fixtures,
      "../../helpers/repository-scaffolding": fixtures,
      dugite: fixtures
    }
  },
  ...["branch", "checkout", "merge", "ref", "diff-check"].map(name => ({
    file: `desktop/${name}-test.ts`,
    globals: false,
    imports: Object.fromEntries([
      ...(name === "branch" || name === "checkout"
        ? [
            ["../../helpers/test-app-shell", adapter],
            ["../../../src/models/tip", adapter],
            ["../../../src/lib/stores", adapter],
            ["../../helpers/test-stats-store", adapter]
          ]
        : []),
      ...(name === "checkout"
        ? [
            ["../../../src/models/branch", adapter],
            ["../../../src/lib/path-exists", fixtures]
          ]
        : []),
      ...(name === "branch" ? [["../../../src/lib/fatal-error", adapter]] : []),
      ...(name === "ref" ? [["../../../src/lib/git/refs", adapter]] : []),
      ...(name === "diff-check" ? [["../../../src/lib/git/diff-check", adapter]] : []),
      ...(name === "merge" ? [["../../../src/lib/git/core", adapter]] : []),
      ...(name === "ref" || name === "diff-check"
        ? []
        : [
            ["../../../src/models/repository", fixtures],
            ["../../../src/lib/git", adapter],
            ["dugite", fixtures]
          ]),
      ...(name === "checkout" ? [["../../helpers/status", adapter]] : []),
      ["../../helpers/repositories", fixtures]
    ])
  })),

  {
    file: "desktop/filter-changes-logic-test.ts",
    globals: false,
    imports: {
      "../../src/models/status": upstream("models/status.ts"),
      "../../src/models/diff": upstream("models/diff/index.ts"),
      "../../src/ui/changes/filter-changes-logic": join(root, "../../src/lib/desktop-filter-changes.ts"),
      "../../src/lib/app-state": fixtures,
      "../../src/ui/changes/filter-changes-list": fixtures
    }
  },
  {
    file: "gitlens/indexParser.test.ts",
    globals: true,
    imports: {
      "../indexParser.js": adapter,
      "@gitlens/git/models/fileStatus.js": join(root, "upstream/gitlens/packages/git/src/models/fileStatus.ts")
    }
  },
  ...["squash", "reorder"].map(operation => ({
    file: `desktop/${operation}-test.ts`,
    globals: false,
    imports: {
      "../../../src/lib/git": adapter,
      "../../../src/models/commit": fixtures,
      "../../../src/models/repository": fixtures,
      "../../helpers/repositories": fixtures,
      "../../helpers/repository-scaffolding": fixtures,
      dugite: fixtures,
      "../../helpers/status": adapter,
      "../../../src/lib/file-system": fixtures,
      [`../../../src/lib/git/${operation}`]: adapter
    }
  })),

  ...["rev-parse-test.ts", "config-test.ts", "revert-test.ts"].map(file => ({
    file: `desktop/${file}`,
    globals: false,
    imports:
      file === "revert-test.ts"
        ? {
            "../../../src/lib/git/revert": adapter,
            "../../../src/lib/git": adapter,
            "../../helpers/repositories": fixtures,
            "../../helpers/repository-scaffolding": fixtures,
            "../../helpers/git": adapter
          }
        : {
            "../../../src/models/repository": fixtures,
            ...(file === "rev-parse-test.ts"
              ? { "../../../src/lib/git/rev-parse": adapter, "../../../src/lib/git/core": fixtures }
              : { "../../../src/lib/git": adapter }),
            "../../helpers/repositories": fixtures,
            dugite: fixtures,
            "../../helpers/temp": fixtures,
            "../../helpers/ownership-check": fixtures,
            "../../../src/lib/git/config": adapter
          }
  })),

  { file: "gitlens/worktreeParser.test.ts", globals: true, imports: { "../worktreeParser.js": adapter } },
  {
    file: "gitlens/statusParser.test.ts",
    globals: true,
    imports: {
      "../statusParser.js": adapter,
      "@gitlens/git/models/fileStatus.js": join(root, "upstream/gitlens/packages/git/src/models/fileStatus.ts"),
      "@gitlens/git/utils/branch.utils.js": join(root, "upstream/gitlens/packages/git/src/utils/branch.utils.ts"),
      "@gitlens/utils/uri.js": join(root, "upstream/gitlens/packages/utils/src/uri.ts")
    }
  },
  { file: "gitlens/search.utils.test.ts", globals: true, imports: { "../search.utils.js": adapter } },
  {
    file: "gitlens/autolink.utils.test.ts",
    globals: true,
    imports: {
      "../autolink.utils.js": join(root, "../../src/lib/autolinks.ts"),
      "../../models/autolink.js": join(root, "upstream/gitlens/packages/git/src/models/autolink.ts")
    }
  },
  {
    file: "gitlens/autolinks.test.ts",
    globals: true,
    imports: {
      "../utils/-webview/autolinks.utils.js": join(root, "../../src/lib/autolinks.ts"),
      "../models/autolinks.js": join(root, "upstream/gitlens/packages/git/src/models/autolink.ts")
    }
  },
  {
    file: "desktop/patch-formatter-test.ts",
    globals: false,
    imports: {
      "../../src/models/repository": fixtures,
      "../helpers/repositories": fixtures,
      "../../src/models/status": upstream("models/status.ts"),
      "../../src/models/diff": upstream("models/diff/index.ts"),
      "../../src/lib/diff-parser": upstream("lib/diff-parser.ts"),
      "../../src/lib/patch-formatter": upstream("lib/patch-formatter.ts"),
      "../../src/lib/git": join(root, "diff.ts")
    }
  },
  {
    file: "desktop/init-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/git/init": adapter,
      "../../../src/lib/helpers/default-branch": fixtures,
      "../../../src/lib/git": adapter,
      "../../helpers/temp": fixtures,
      dugite: fixtures,
      "../../../src/models/repository": fixtures
    }
  },
  {
    file: "desktop/diff-parser-test.ts",
    globals: false,
    imports: {
      "../../src/lib/diff-parser": upstream("lib/diff-parser.ts"),
      "../../src/models/diff": upstream("models/diff/index.ts")
    }
  },
  {
    file: "desktop/text-diff-expansion-test.ts",
    globals: false,
    imports: {
      dugite: fixtures,
      "../../src/lib/diff-parser": upstream("lib/diff-parser.ts"),
      "../../src/ui/diff/text-diff-expansion": upstream("ui/diff/text-diff-expansion.ts"),
      "../../src/models/diff/diff-data": upstream("models/diff/diff-data.ts"),
      "../../src/models/diff": upstream("models/diff/index.ts")
    }
  },
  ...["remote-management-test.ts", "remote-discovery-test.ts"].map(file => ({
    file: `desktop/${file}`,
    globals: false,
    imports: Object.fromEntries([
      ["../../../src/lib/git/core", fixtures],
      ["../../../src/lib/git/remote", adapter],
      ["../../helpers/git-config", fixtures],
      ["../../helpers/repositories", fixtures],
      ...(file === "remote-discovery-test.ts" ? [["../../../src/lib/git/config", fixtures]] : [])
    ])
  })),
  { file: "gitlens/blameParser.test.ts", globals: true, imports: { "../blameParser.js": adapter } },
  // GitLens integration suites: original helpers.ts snapshot, CliGitProvider shim over the Rust bridge
  // (gitlens-integration.ts); Mocha TDD globals and excluded blocks come from gitlens-integration-adaptations.ts.
  ...["tags", "remotes", "worktrees", "config", "config.upstreamKeys", "clone", "provider", "refs"].map(name => ({
    file: `gitlens/integration/${name}.test.ts`,
    globals: false,
    imports: {
      "./helpers.js": join(root, "upstream/gitlens/packages/git-cli/src/providers/__tests__/integration/helpers.ts"),
      ...(name === "provider"
        ? {
            "../../../cliGitProvider.js": join(root, "gitlens-integration.ts"),
            "../../../exec/locator.js": join(root, "gitlens-integration.ts")
          }
        : {})
    }
  })),
  // GitLens status/stash/pausedOperations/branches/commits and operations/graph integration suites on the same shim.
  ...[
    "status",
    "stash",
    "pausedOperations",
    "branches",
    "commits",
    "operations",
    "operations.upstreamRemote",
    "operations.indexLockHook",
    "graph.slashRemote",
    "graph.stashRows"
  ].map(name => ({
    file: `gitlens/integration/${name}.test.ts`,
    globals: false,
    imports: {
      "./helpers.js": join(root, "upstream/gitlens/packages/git-cli/src/providers/__tests__/integration/helpers.ts")
    }
  })),
  {
    file: "gitlens/revision.utils.test.ts",
    globals: true,
    imports: {
      "../revision.utils.js": adapter,
      "../../models/revision.js": join(root, "upstream/gitlens/packages/git/src/models/revision.ts")
    }
  },
  { file: "gitlens/fileStatus.utils.test.ts", globals: true, imports: { "../fileStatus.utils.js": adapter } },
  { file: "gitlens/remote.test.ts", globals: true, imports: { "../remote.utils.js": adapter } },
  { file: "gitlens/branch.utils.test.ts", globals: true, imports: { "../branch.utils.js": adapter } },
  ...["commits.searchTypeMerge", "revision", "gitIgnoreFilter"].map(name => ({
    file: `gitlens/${name}.test.ts`,
    globals: true,
    imports: { "./helpers.js": gitlensIntegrationHelpers },
    gitlensHelperImports: gitlensLocalHelperImports
  })),
  {
    file: "gitlens/revParseGitDir.test.ts",
    globals: true,
    imports: {
      "./helpers.js": gitlensIntegrationHelpers,
      "../../../exec/git.js": gitlensIntegrationLocal,
      "../../../exec/locator.js": gitlensIntegrationLocal
    },
    gitlensHelperImports: gitlensLocalHelperImports
  },
  {
    file: "gitlens/env.gitDir.test.ts",
    globals: true,
    imports: {
      "./helpers.js": gitlensIntegrationHelpers,
      "../../../cliGitProvider.js": gitlensIntegrationLocal,
      "../../../exec/locator.js": gitlensIntegrationLocal
    },
    gitlensHelperImports: gitlensLocalHelperImports
  },
  {
    file: "desktop/gitignore-test.ts",
    globals: false,
    imports: {
      "../../../src/lib/path-exists": fixtures,
      dugite: fixtures,
      "../../helpers/repositories": fixtures,
      "../../helpers/local-config": fixtures,
      "../../helpers/status": adapter,
      "../../../src/lib/git": adapter
    }
  }
]
try {
  const registry = JSON.parse(await readFile(join(root, "sources.json"), "utf8"))
  const registered = Object.keys(registry.sources)
    .filter(file => !registry.sources[file].excluded)
    .toSorted()
  if (JSON.stringify(suites.map(suite => suite.file).toSorted()) !== JSON.stringify(registered)) {
    throw new Error("Upstream suite registry and runner differ")
  }
  for (const [path, metadata] of Object.entries({
    ...Object.fromEntries(Object.entries(registry.sources).map(([key, value]) => [`upstream/${key}`, value])),
    ...registry.support
  }) as [string, { sha256: string }][]) {
    const digest = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex")
    if (digest !== metadata.sha256) throw new Error(`Upstream snapshot modified: ${path}`)
  }
  const tests: string[] = []
  const sourceConfigurations: Record<string, unknown> = {}
  const regressions = [
    {
      file: "status-responsiveness.test.ts",
      local: true,
      unbundled: true,
      globals: false,
      imports: {
        "./e2e/fixtures.ts": join(root, "e2e/fixtures.ts"),
        "./upstream/desktop/e2e/test-helpers.ts": join(root, "upstream/desktop/e2e/test-helpers.ts")
      }
    },
    { file: "stats-disabled.test.ts", local: true, unbundled: true, globals: false, imports: {} },
    {
      file: "macos-workflows.test.ts",
      local: true,
      unbundled: true,
      globals: false,
      imports: {
        "./e2e/fixtures.ts": join(root, "e2e/fixtures.ts"),
        "./upstream/desktop/e2e/test-helpers.ts": join(root, "upstream/desktop/e2e/test-helpers.ts")
      }
    },
    { file: "workflow-navigation.test.ts", local: true, globals: false, imports: {} },
    { file: "branch-workflows.test.ts", local: true, globals: false, imports: {} },
    { file: "autolinks.test.ts", local: true, globals: false, imports: {} },
    { file: "coalescing-runner.test.ts", local: true, globals: false, imports: {} },
    { file: "feature-stores.test.ts", local: true, globals: false, imports: {} },
    { file: "push-pull-state.test.ts", local: true, globals: false, imports: {} },
    { file: "device-authorization.test.ts", local: true, globals: false, imports: {} },
    { file: "native-checks-dispatcher.test.ts", local: true, globals: false, imports: {} },
    {
      file: "terminal-output.test.ts",
      local: true,
      globals: false,
      imports: { "../../src/lib/terminal-output-decoder": join(root, "../../src/lib/terminal-output-decoder.ts") }
    },
    {
      file: "remote-repos.test.ts",
      local: true,
      globals: false,
      imports: { "../../src/lib/remote-repos": join(root, "../../src/lib/remote-repos.ts") }
    },
    {
      file: "account-state.test.ts",
      local: true,
      globals: false,
      imports: { "../../src/lib/account-state": join(root, "../../src/lib/account-state.ts") }
    },
    { file: "repository-policy.test.ts", local: true, globals: false, imports: {} },
    { file: "unpushed-indicator.test.ts", local: true, globals: false, imports: {} },
    { file: "commit-line-counts.test.ts", local: true, globals: false, imports: {} },
    { file: "changes-context-menu.test.ts", local: true, globals: false, imports: {} },
    { file: "no-changes-suggestions.test.ts", local: true, globals: false, imports: {} },

    {
      file: "selection.test.ts",
      globals: false,
      local: true,
      imports: {
        "./fixtures.ts": fixtures,
        "./bridge.ts": adapter,
        "../../src/lib/stage": join(root, "../../src/lib/stage.ts"),
        "../../src/upstream/models/diff": upstream("models/diff/index.ts")
      }
    }
  ]
  const requested = process.argv.slice(2).filter(argument => argument !== "--no-native")
  // --no-native leaves out the suites that launch the native app window (and inject keys).
  const native = (suite: { imports: Record<string, string> }) =>
    Object.values(suite.imports).some(path => path.endsWith("e2e/fixtures.ts"))
  const allSuites = [...suites, ...regressions].filter(suite => !process.argv.includes("--no-native") || !native(suite))
  for (const file of requested) {
    if (!allSuites.some(suite => suite.file === file)) throw new Error(`Unknown suite: ${file}`)
  }
  for (const suite of allSuites.filter(suite => requested.length === 0 || requested.includes(suite.file))) {
    let source = await readFile(join(root, "local" in suite ? "" : "upstream", suite.file), "utf8")
    for (const [original, target] of Object.entries(suite.imports)) {
      const needles = ["'", '"'].flatMap(quote => [
        [`from ${quote}${original}${quote}`, `from ${JSON.stringify(target)}`],
        [`import(${quote}${original}${quote})`, `import(${JSON.stringify(target)})`]
      ])
      const dynamic = new RegExp(
        `import\\(\\s*['"]${original.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}['"]\\s*\\)`,
        "g"
      )
      if (!needles.some(([needle]) => source.includes(needle)) && !dynamic.test(source))
        throw new Error(`Upstream import changed: ${suite.file}: ${original}`)
      source = source.replace(dynamic, () => `import(${JSON.stringify(target)})`)
      for (const [needle, replacement] of needles) source = source.replaceAll(needle, replacement)
    }
    const { mocks = {} } = suite as { mocks?: Record<string, string> }
    for (const original of Object.keys(mocks)) {
      if (!["'", '"'].some(quote => source.includes(`mock.module(${quote}${original}${quote}`)))
        throw new Error(`Upstream module mock changed: ${suite.file}: ${original}`)
    }
    source = withoutNativeDetails(suite.file, withoutRemovedCopilot(suite.file, source))
    source = withoutGitHubSearchCommand(suite.file, source)
    source = withoutUnportedGitLensBlocks(suite.file, source)
    source = withGitLensIntegrationGlobals(suite.file, source)
    source = adaptUIDom(suite.file, source, join(root, "control-state.ts"))
    let suiteDirectory = root
    if (suite.file === "desktop/e2e/app-launch-test.ts") {
      suiteDirectory = join(temporary, "app/test/e2e")
      await mkdir(suiteDirectory, { recursive: true })
    }
    if (suite.file === "desktop/git/refreshable-credentials-test.ts") {
      suiteDirectory = join(buildDirectory, "native/app/test/unit/git")
      const bin = join(suiteDirectory, "../../../node_modules/desktop-trampoline/build/Release")
      await mkdir(bin, { recursive: true })
      const probe = Bun.spawnSync([join(root, "../../src-tauri/target/debug/examples/conformance")], {
        stdin: new TextEncoder().encode(JSON.stringify({ operation: "trampoline/build-paths" }))
      })
      if (probe.exitCode !== 0) throw new Error("Cannot locate compiled original trampoline")
      const paths = JSON.parse(new TextDecoder().decode(probe.stdout))
      await copyFile(
        paths.credentialHelper,
        join(bin, `desktop-credential-helper-trampoline${process.platform === "win32" ? ".exe" : ""}`)
      )
    }
    source = `const __APP_NAME__ = "GitCub"; const __WIN32__ = ${process.platform === "win32"}; const __dirname = ${JSON.stringify(suite.file === "desktop/native-module-build-test.ts" ? join(root, "upstream/desktop/script") : suiteDirectory)};\n${
      source
    }`
    if (registry.sources[suite.file]?.source.endsWith(".tsx"))
      source = `import ${JSON.stringify(join(root, "react-environment.ts"))};\n${source}`
    if (suite.globals) {
      // Mocha TDD 钩子：只映射套件实际调用的那几个。
      const hooks = Object.entries({
        suiteSetup: "before",
        suiteTeardown: "after",
        setup: "beforeEach",
        teardown: "afterEach"
      })
        .filter(([name]) => new RegExp(String.raw`^\s*${name}\(`, "m").test(source))
        .map(([name, hook]) => `, ${hook} as ${name}`)
        .join("")
      source = `import { describe as suite, it as test${hooks} } from "node:test";\n${source}`
    }
    const path = join(buildDirectory, `${suite.file.replaceAll("/", "-")}.test.mjs`)
    const entry = path + (registry.sources[suite.file]?.source.endsWith(".tsx") ? ".tsx" : ".ts")
    await writeFile(entry, source)
    if (suite.file === "desktop/ipc-contract-test.ts") {
      const project = join(buildDirectory, "ipc-contract.tsconfig.json")
      await writeFile(
        project,
        JSON.stringify({
          extends: join(root, "../../tsconfig.json"),
          compilerOptions: { allowImportingTsExtensions: true },
          include: [join(root, "../../src"), entry]
        })
      )
      const checked = Bun.spawn(
        [process.execPath, join(root, "../../node_modules/typescript/bin/tsc"), "--noEmit", "--project", project],
        { stdout: "inherit", stderr: "inherit" }
      )
      if ((await checked.exited) !== 0) throw new Error("Original IPC contract failed its compile-time assertions")
    }
    if ("unbundled" in suite && suite.unbundled) {
      sourceConfigurations[entry] = { root, imports: suite.imports, mocks }
      await writeFile(
        entry,
        `import { createRequire as __createRequire } from "node:module"; ${/\b(?:const|let|var)\s+require\s*=/.test(source) ? "" : "const require=__createRequire(import.meta.url);"} const __filename = ${JSON.stringify(entry)};\n${source.replace(
          /const __WIN32__ = (true|false); /,
          ""
        )}`
      )
      tests.push(entry)
      continue
    }
    const build = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      // React's async act uses module.require("timers") in Node. Bundling its
      // CommonJS wrapper makes it fall back to browser MessageChannels which
      // keep the test process alive. Use one native React instance instead.
      external: [
        "react",
        "react/*",
        "react-dom",
        "react-dom/*",
        "scheduler",
        "@base-ui/*",
        "@floating-ui/*",
        "@testing-library/*"
      ],
      plugins: [
        {
          name: "tauri-test-transport",
          setup(build) {
            const { gitlensHelperImports } = suite as { gitlensHelperImports?: Record<string, string> }
            if (gitlensHelperImports)
              build.onResolve({ filter: /./ }, args => {
                if (args.importer !== gitlensIntegrationHelpers) return
                const path = gitlensHelperImports[args.path]
                return path ? { path } : undefined
              })
            build.onResolve(
              {
                filter:
                  /^(?:@gitlens\/|@vscode\/l10n$|#env\/|\.\.\/utils\/status\.utils\.js$|\.\.\/\.\.\/\.\.\/(?:cliGitProvider|exec\/locator|service)\.js$|\.\/shadowCheck\.js$)/
              },
              args => {
                const path = resolveGitLensModule(args.path, args.importer, root)
                return path ? { path } : undefined
              }
            )
            build.onResolve({ filter: /^(?:\.\.\/){2,4}src\/ui\// }, args => {
              const original = args.path.split("/src/")[1].replace(/\.(tsx?|jsx?)$/, "")
              const target = (desktopUIPaths as Record<string, string>)[original]
              return target ? { path: join(root, "../../src", target) } : undefined
            })
            build.onResolve(
              { filter: /^(react(?:\/|$)|react-dom(?:\/|$)|scheduler$|@base-ui\/|@floating-ui\/|@testing-library\/)/ },
              args => ({
                path: args.path,
                external: true
              })
            )
            build.onResolve({ filter: /^\.\.\/\.\.\/src\// }, args => {
              if (!/(app-store-test-harness|repository-builder-branch-pruner|temp)\.ts$/.test(args.importer)) return
              const rel = args.path.slice("../../src/".length)
              const paths = ["../../src/", "../../src/upstream/"].flatMap(base =>
                [".ts", "/index.ts"].map(ext => join(root, base + rel + ext))
              )
              const path = paths.find(existsSync)
              return path ? { path } : undefined
            })
            build.onResolve({ filter: /^dugite$/ }, args =>
              args.importer.endsWith("/helpers/repository-builder-branch-pruner.ts") ? { path: fixtures } : undefined
            )
            build.onResolve({ filter: /^\.\.\/\.\.\/src\// }, args => {
              if (!args.importer.endsWith("/helpers/repository-builder-branch-pruner.ts")) return
              const paths: Record<string, string> = {
                "../../src/lib/stores": "../../src/lib/stores/index.ts",
                "../../src/lib/stores/repository-state-cache": "../../src/lib/stores/repository-state-cache.ts"
              }
              return paths[args.path] ? { path: join(root, paths[args.path]) } : undefined
            })
            build.onResolve({ filter: /^\.\/temp$/ }, args =>
              args.importer.endsWith("/helpers/git-config.ts") ? { path: fixtures } : undefined
            )
            build.onResolve({ filter: /^\.\.\/\.\.\/src\// }, args => {
              if (!/(changes-state-helper|test-stats-store)\.ts$/.test(args.importer)) return
              const paths: Record<string, string> = {
                "../../src/lib/app-state": "../../src/models/desktop-changes-state.ts",
                "../../src/models/status": "../../src/upstream/models/status.ts",
                "../../src/lib/merge": "../../src/upstream/lib/merge.ts",
                "../../src/lib/git": "../../src/lib/status-contract.ts",
                "../../src/models/commit-message": "../../src/upstream/models/commit-message.ts",
                "../../src/models/repo-rules": "../../src/upstream/models/repo-rules.ts",
                "../../src/lib/stats/stats-store": "../../src/lib/stats/stats-contract.ts"
              }
              return paths[args.path] ? { path: join(root, paths[args.path]) } : undefined
            })

            build.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/src\/lib\/databases$/ }, args =>
              args.importer.includes("/helpers/databases/")
                ? { path: join(root, "../../src/lib/databases/index.ts") }
                : undefined
            )

            build.onResolve({ filter: /^node:test$/ }, args =>
              suite.file === "desktop/reset-test.ts" && args.importer !== join(root, "enable-reset-test.mjs")
                ? { path: join(root, "enable-reset-test.mjs") }
                : { path: "node:test", external: true }
            )
            build.onResolve({ filter: /^focus-trap-react$/ }, args =>
              args.importer === join(root, "focus-trap.tsx")
                ? { path: Bun.resolveSync(args.path, join(root, "../..")) }
                : { path: join(root, "focus-trap.tsx") }
            )
            build.onResolve({ filter: /^[^./]/ }, args => {
              if (!args.importer.startsWith(buildDirectory) || isBuiltin(args.path) || args.path === "electron") return
              return { path: Bun.resolveSync(args.path, join(root, "../..")) }
            })

            build.onResolve({ filter: /^electron$/ }, () => ({ path: join(root, "electron.ts") }))
            build.onResolve({ filter: /^@tauri-apps\/plugin-opener$/ }, () => ({ path: join(root, "opener.ts") }))

            build.onResolve({ filter: /^\.\/build-environment$/ }, args =>
              args.importer.endsWith("/src/lib/desktop-features.ts")
                ? { path: join(root, "build-environment.ts") }
                : undefined
            )
            build.onResolve({ filter: /^\.\.\/\.\.\/src\/lib\/api$/ }, args =>
              args.importer.endsWith("/helpers/mock-api.ts") ? { path: join(root, "../../src/lib/api.ts") } : undefined
            )

            build.onResolve(
              { filter: /^(\.\.\/\.\.\/src\/models\/repository|\.\/repositories|\.\/repository-scaffolding)$/ },
              args =>
                args.importer.startsWith(join(root, "upstream/desktop/helpers/")) ? { path: fixtures } : undefined
            )
            build.onResolve({ filter: /^\.\.\/\.\.\/src\/(models\/(github-repository|owner)|lib\/api)$/ }, args => {
              if (!args.importer.endsWith("helpers/github-repo-builder.ts")) return
              const path = args.path.includes("/models/")
                ? `${args.path.replace("../../src/", "../../src/")}.ts`
                : "../../src/lib/desktop-api-urls.ts"
              return { path: join(root, path) }
            })
            build.onResolve({ filter: /^(?:\.\/|\.\.\/)platform-environment$/ }, () => ({
              path: join(root, "platform-environment.ts")
            }))
            build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: join(root, "tauri.ts") }))
            build.onResolve({ filter: /^@tauri-apps\/plugin-os$/ }, () => ({ path: join(root, "os.ts") }))
          }
        }
      ]
    })
    if (!build.success) throw new AggregateError(build.logs, `Cannot bundle ${suite.file}`)
    await writeFile(path, await build.outputs[0].text())
    tests.push(path)
  }
  // Desktop's remote-test fetches https://github.com/desktop/not-found.git with a blob filter only to
  // observe the recorded promisor flag; serve that URL from a local repository so the suite is hermetic.
  const promisorSource = join(temporary, "desktop-not-found")
  for (const args of [
    ["init", "-q", "-b", "main", promisorSource],
    [
      "-C",
      promisorSource,
      "-c",
      "user.name=Conformance",
      "-c",
      "user.email=conformance@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init"
    ]
  ]) {
    const result = Bun.spawnSync(["git", ...args], { stdout: "ignore", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
  await writeFile(join(temporary, "empty-gitconfig"), "")
  // Suites rewrite the isolated global config; the system file stays untouched.
  await writeFile(
    join(temporary, "system-gitconfig"),
    `[url "${pathToFileURL(promisorSource).href}"]\n\tinsteadOf = https://github.com/desktop/not-found.git\n`
  )
  await writeFile(join(temporary, "sources.json"), JSON.stringify(sourceConfigurations))
  const executable = process.env.JS_TEST_RUNTIME ?? process.execPath
  const probe = Bun.spawnSync([executable, "-p", "Boolean(process.versions.bun)"], {
    stdout: "pipe",
    stderr: "inherit"
  })
  if (probe.exitCode !== 0) throw new Error("Cannot start the configured JavaScript test runtime")
  const isBun = probe.stdout.toString().trim() === "true"
  // Each Bun process gets one source mapping and fresh module mocks, like node:test workers.
  const groups = isBun ? tests.map(test => [test]) : [tests]
  for (const group of groups) {
    const child = Bun.spawn(
      [
        executable,
        ...(isBun
          ? ["test", "--preload", join(root, "source-loader.mjs"), "--preload", join(root, "environment.mjs")]
          : [
              "--experimental-test-module-mocks",
              "--import",
              join(root, "source-loader.mjs"),
              "--import",
              join(root, "environment.mjs"),
              "--test",
              "--test-concurrency=1"
            ]),
        ...group
      ],
      {
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...process.env,
          GITCUB_SOURCE_TEST_INDEX: join(temporary, "sources.json"),
          GIT_CONFIG_GLOBAL: join(temporary, "empty-gitconfig"),
          GIT_CONFIG_SYSTEM: join(temporary, "system-gitconfig"),
          GITCUB_FIXTURES_ROOT: join(root, "fixtures"),
          TMPDIR: temporary,
          TEMP: temporary,
          TMP: temporary,
          GITCUB_CONFORMANCE_BIN: join(
            root,
            `../../src-tauri/target/debug/examples/conformance${process.platform === "win32" ? ".exe" : ""}`
          ),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Joe Bloggs",
          GIT_AUTHOR_EMAIL: "joe.bloggs@somewhere.com",
          GIT_COMMITTER_NAME: "Joe Bloggs",
          GIT_COMMITTER_EMAIL: "joe.bloggs@somewhere.com"
        }
      }
    )
    const exitCode = await child.exited
    if (exitCode !== 0) process.exitCode = exitCode
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
  await rm(buildDirectory, { recursive: true, force: true })
}
