import { useMemo } from "react"

import { useAccountsStore } from "../../features/accounts/store"
import { getHTMLURL } from "../../lib/api"
import type { IMentionableUser } from "../../lib/databases/github-user-database"
import { getDesktopRuntime } from "../../lib/desktop-runtime"
import { EMOJI } from "../../lib/emoji"
import { ipc } from "../../lib/ipc"
import { completionRepository, mentionableUsersSource } from "../../lib/mentionable-users"
import type { Account } from "../../models/account"
import type { Issue, Remote } from "../../models/app-state"
import { EmojiAutocompletionProvider } from "../autocompletion/emoji-autocompletion-provider"
import type { IAutocompletionProvider } from "../autocompletion/provider-contract"
import {
  CoAuthorAutocompletionProvider,
  UserAutocompletionProvider
} from "../autocompletion/user-autocompletion-provider"

/** Desktop buildAutocompletionProviders：提交表单与 CommitMessageDialog（压缩提交）共用的 `#` issue、emoji、`@` 用户与共同作者补全 */
export function useAutocompletionProviders(
  issues: readonly Issue[],
  mentionables: readonly IMentionableUser[],
  remote: Remote | null,
  accounts: ReadonlyArray<Account>
) {
  const platformAccounts = useAccountsStore(s => s.accounts)
  const runtime = getDesktopRuntime()
  return useMemo(() => {
    const issueProvider: IAutocompletionProvider<Issue> = {
      kind: "issue",
      getRegExp: () => /(?:^|\n| )(?:#)([a-z\d\\+-][a-z\d_]*)?/g,
      getAutocompletionItems: async text =>
        issues
          .filter(issue => `${issue.number} ${issue.title}`.toLowerCase().includes(text.toLowerCase()))
          .slice(0, 20),
      getCompletionText: issue => `#${issue.number}`,
      getItemAriaLabel: issue => `#${issue.number} ${issue.title}`,
      renderItem: issue => (
        <div className="issue">
          <span className="number">#{issue.number}</span> {issue.title}
        </div>
      )
    }
    const providers: IAutocompletionProvider<object>[] = [
      issueProvider,
      new EmojiAutocompletionProvider(
        new Map(Object.entries(EMOJI).map(([name, emoji]) => [name, { emoji, aliases: [name], url: "" }]))
      )
    ]
    // Desktop buildAutocompletionProviders：托管仓库再加 `@` 用户与共同作者补全，账号按仓库所在实例找
    if (remote) {
      const gitlab = platformAccounts[remote.host]?.kind === "gitlab"
      const repository = completionRepository(remote, gitlab)
      const account = gitlab
        ? undefined
        : accounts.find(account => new URL(getHTMLURL(account.endpoint)).host === remote.host)
      const source = mentionableUsersSource(
        mentionables,
        runtime.gitHubUserStore,
        gitlab ? login => ipc.mentionableUser(remote.host, login).catch(() => null) : undefined
      )
      providers.push(
        new UserAutocompletionProvider(source, repository, account),
        new CoAuthorAutocompletionProvider(source, repository, account)
      )
    }
    return providers
  }, [issues, mentionables, remote, accounts, platformAccounts, runtime])
}
