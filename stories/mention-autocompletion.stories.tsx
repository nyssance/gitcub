import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import type { IMentionableUser } from "../src/lib/databases/github-user-database"
import { completionRepository, mentionableUsersSource } from "../src/lib/mentionable-users"
import { AutocompletingTextArea } from "../src/ui/autocompletion/inputs"
import {
  CoAuthorAutocompletionProvider,
  UserAutocompletionProvider
} from "../src/ui/autocompletion/user-autocompletion-provider"

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
  parameters: {
    // Desktop autocompleting-text-input.tsx 原样给 textarea 加 role="combobox"（ARIA in HTML 不允许），按原版保留
    a11y: { config: { rules: [{ id: "aria-allowed-role", enabled: false }] } }
  },
  args: { host: "github.com", gitlab: false }
} satisfies Meta<typeof MentionInput>
export default meta
type Story = StoryObj<typeof meta>

/** 按用户名和真名的子串匹配，越靠前越先；选中后插入 `@用户名` */
export const MatchesLoginAndName: Story = {
  play: async ({ canvas }) => {
    const input = canvas.getByRole("combobox", { name: "Commit description" })
    await userEvent.type(input, "Thanks @octo")
    const screen = within(document.body)
    await waitFor(() => expect(screen.getByText("octocat")).toBeVisible())
    // 「Mona Octo」靠真名命中，排在用户名命中之后；hubot 不匹配
    await expect(screen.getByText("monalisa")).toBeVisible()
    await expect(screen.queryByText("hubot")).not.toBeInTheDocument()
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(input).toHaveValue("Thanks @octocat "))
  }
}

/** Desktop：github.com 上额外能 @Copilot */
export const DotComOffersCopilot: Story = {
  play: async ({ canvas }) => {
    await userEvent.type(canvas.getByRole("combobox", { name: "Commit description" }), "@cop")
    await expect(await within(document.body).findByText("Copilot")).toBeVisible()
  }
}

/** GitLab 用同一套补全，但不会冒出 GitHub 的 Copilot */
export const GitLabHasNoCopilot: Story = {
  args: { host: "gitlab.example", gitlab: true },
  play: async ({ canvas }) => {
    const input = canvas.getByRole("combobox", { name: "Commit description" })
    await userEvent.type(input, "@hub")
    const screen = within(document.body)
    await expect(await screen.findByText("hubot")).toBeVisible()
    await userEvent.clear(input)
    await userEvent.type(input, "@cop")
    await new Promise(resolve => setTimeout(resolve, 300))
    await expect(screen.queryByText("Copilot")).not.toBeInTheDocument()
  }
}

/** 共同作者手填用户名：GitLab 账号不在 Desktop 账号库里，按平台接口解析成已知作者；没有解析器时照原版是 null */
export const GitLabResolvesTypedCoAuthor: Story = {
  args: { host: "gitlab.example", gitlab: true },
  play: async () => {
    const repository = completionRepository({ host: "gitlab.example", owner: "gitcub", name: "gitcub" }, true)
    const dev = { login: "dev", name: "Dev", email: "42-dev@users.noreply.gitlab.example", avatarURL: "" }
    const resolving = new CoAuthorAutocompletionProvider(
      mentionableUsersSource(users, { getByLogin: async () => null }, async login => (login === "dev" ? dev : null)),
      repository
    )
    await expect(await resolving.exactMatch("dev")).toEqual({
      kind: "known-user",
      username: "dev",
      name: "Dev",
      email: "42-dev@users.noreply.gitlab.example",
      endpoint: "https://gitlab.example/api/v4"
    })
    await expect(await resolving.exactMatch("nobody")).toBeNull()
    const original = new CoAuthorAutocompletionProvider(
      mentionableUsersSource(users, { getByLogin: async () => null }),
      repository
    )
    await expect(await original.exactMatch("dev")).toBeNull()
  }
}
