import type { Remote } from "@/models/app-state"
import { copilotSweAgentBot } from "@/models/dot-com-bots"
import { GitHubRepository } from "@/models/github-repository"
/**
 * Desktop buildAutocompletionProviders 的 `@` 用户与共同作者补全。候选列表由 Rust 按贡献目标取
 * （GitHub mentionables / GitLab 项目用户），匹配排序照 GitHubUserStore.getMentionableUsersMatching；
 * 按用户名精确解析（共同作者手填）仍走 Desktop 的 GitHubUserStore.getByLogin。
 */
import { Owner } from "@/models/owner"

import type { MentionableUsersSource } from "../ui/autocompletion/user-autocompletion-provider"
import { getAPIEndpoint } from "./api"
import type { IMentionableUser } from "./databases/github-user-database"
import { getStealthEmailForUser } from "./email"
import { isDotCom } from "./endpoint-capabilities"
import type { GitHubUserStore } from "./stores/github-user-store"
import { matchMentionableUsers } from "./stores/github-user-store"

/** 补全只用到 endpoint；GitLab 给的是它自己的 API 地址，不会被当成 github.com */
export function completionRepository(remote: Remote, gitlab: boolean) {
  const endpoint = gitlab ? `https://${remote.host}/api/v4` : getAPIEndpoint(`https://${remote.host}`)
  return new GitHubRepository(remote.name, new Owner(remote.owner, endpoint, -1), -1)
}

export function mentionableUsersSource(
  users: readonly IMentionableUser[],
  gitHubUserStore: Pick<GitHubUserStore, "getByLogin">,
  resolveWithoutAccount?: (login: string) => Promise<IMentionableUser | null>
): MentionableUsersSource {
  return {
    getByLoginWithoutAccount: resolveWithoutAccount,
    // Desktop GitHubUserStore.getMentionableUsers：github.com 上补一个 Copilot
    getMentionableUsersMatching: async (repository, query, maxHits) => {
      let candidates = users
      if (isDotCom(repository.endpoint) && !users.some(user => user.login === "Copilot")) {
        const { userId, login, avatarURL, endpoint } = copilotSweAgentBot
        candidates = [
          ...users,
          { login, name: login, email: getStealthEmailForUser(userId, login, endpoint), avatarURL }
        ]
      }
      return matchMentionableUsers(candidates, query, maxHits)
    },
    getByLogin: (account, login) => gitHubUserStore.getByLogin(account, login)
  }
}
