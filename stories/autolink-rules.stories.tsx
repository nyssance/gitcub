import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import i18n from "../src/lib/i18n"
import { AutolinkRules } from "../src/ui/preferences/autolink-rules"

const jira = {
  prefix: "JIRA-",
  url: "https://jira.example.com/browse/JIRA-<num>",
  alphanumeric: false,
  ignoreCase: true,
  title: "Issue <num>"
}

const meta = {
  title: "Settings/Autolink rules",
  component: AutolinkRules,
  args: { rules: [jira], onChange: fn() },
  decorators: [
    Story => (
      <div className="w-[640px] px-4">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof AutolinkRules>
export default meta
type Story = StoryObj<typeof meta>

export const Rules: Story = {
  play: async ({ canvas }) => {
    const list = canvas.getByRole("list", { name: i18n.t("prefs.autolinks") })
    await expect(within(list).getByRole("textbox", { name: i18n.t("prefs.autolinkPrefix") })).toHaveValue("JIRA-")
    await expect(within(list).getByRole("checkbox", { name: i18n.t("prefs.autolinkIgnoreCase") })).toBeChecked()
    await expect(within(list).getByRole("checkbox", { name: i18n.t("prefs.autolinkAlphanumeric") })).not.toBeChecked()
  }
}

export const Empty: Story = {
  args: { rules: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(i18n.t("prefs.autolinkNone"))).toBeVisible()
  }
}

// Adding a row persists nothing until prefix and a <num> URL are filled in; the row shows why.
export const AddAndValidate: Story = {
  args: { rules: [] },
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("prefs.autolinkAdd") }))
    await expect(args.onChange).toHaveBeenLastCalledWith([])
    await expect(canvas.getByRole("alert")).toHaveTextContent(i18n.t("prefs.autolinkPrefixRequired"))
    const prefix = canvas.getByRole("textbox", { name: i18n.t("prefs.autolinkPrefix") })
    await userEvent.type(prefix, "GL-")
    await expect(canvas.getByRole("alert")).toHaveTextContent(i18n.t("prefs.autolinkUrlRequired"))
    const url = canvas.getByRole("textbox", { name: i18n.t("prefs.autolinkUrl") })
    await userEvent.type(url, "https://tracker.example/GL-")
    await expect(canvas.getByRole("alert")).toHaveTextContent(i18n.t("prefs.autolinkUrlNum"))
    await expect(url).toHaveAttribute("aria-invalid", "true")
    await userEvent.type(url, "<num>")
    await waitFor(() => expect(canvas.queryByRole("alert")).not.toBeInTheDocument())
    await userEvent.click(canvas.getByRole("checkbox", { name: i18n.t("prefs.autolinkAlphanumeric") }))
    await expect(args.onChange).toHaveBeenLastCalledWith([
      { prefix: "GL-", url: "https://tracker.example/GL-<num>", alphanumeric: true, ignoreCase: false, title: "" }
    ])
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("prefs.autolinkRemove") }))
    await expect(args.onChange).toHaveBeenLastCalledWith([])
    await expect(canvas.getByText(i18n.t("prefs.autolinkNone"))).toBeVisible()
  }
}
