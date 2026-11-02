import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import type { IMentionableUser } from "../src/lib/databases/github-user-database"
import { completionRepository, mentionableUsersSource } from "../src/lib/mentionable-users"
import { AutocompletingTextArea } from "../src/ui/autocompletion/inputs"
import { UserAutocompletionProvider } from "../src/ui/autocompletion/user-autocompletion-provider"

const users: IMentionableUser[] = [
  { login: "octocat", name: "The Octocat", email: "octocat@users.noreply.github.com", avatarURL: "" },
  { login: "hubot", name: "Hubot", email: "hubot@users.noreply.github.com", avatarURL: "" },
  { login: "monalisa", name: "Mona Octo", email: "mona@example.test", avatarURL: "" }
]

/** 提交描述里的 `@` 补全：Desktop UserAutocompletionProvider，候选来自按贡献目标取的列表 */
function MentionInput({ host, gitlab }: { host: string; gitlab: boolean }) {
  const [value, setValue] = useState("")
  const repository = completionRepository({ host, owner: "gitcub", name: "gitcub" }, gitlab)
  const provider = new UserAutocompletionProvider(
    mentionableUsersSource(users, { getByLogin: async () => null }),
    repository
  )
  return (
    <div style={{ width: 360, padding: 16 }}>
      <AutocompletingTextArea
        inputId="commit-message-description"
        screenReaderLabel="Commit description"
        value={value}
        onValueChanged={setValue}
        autocompletionProviders={[provider]}
      />
    </div>
  )
}

const meta = {
  title: "Changes/Mention autocompletion",
  component: MentionInput,
  args: { host: "github.com", gitlab: false }
} satisfies Meta<typeof MentionInput>
export default meta
type Story = StoryObj<typeof meta>

/** 按用户名和真名的子串匹配，越靠前越先；选中后插入 `@用户名` */
export const MatchesLoginAndName: Story = {}

/** Desktop：github.com 上额外能 @Copilot */
export const DotComOffersCopilot: Story = {}

/** GitLab 用同一套补全，但不会冒出 GitHub 的 Copilot */
export const GitLabHasNoCopilot: Story = {
  args: { host: "gitlab.example", gitlab: true }
}

/** 共同作者手填用户名：GitLab 账号不在 Desktop 账号库里，按平台接口解析成已知作者；没有解析器时照原版是 null */
export const GitLabResolvesTypedCoAuthor: Story = {
  args: { host: "gitlab.example", gitlab: true }
}
