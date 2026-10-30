import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor } from "storybook/test"

import { assertNativeFixtures, installNativeFixtures } from "../.storybook/mocks/native"
import i18n from "../src/lib/i18n"
import { Welcome } from "../src/ui/welcome/welcome"

const meta = {
  title: "Onboarding/Welcome",
  component: Welcome,
  parameters: { layout: "fullscreen" },
  tags: ["desktop-window"],
  beforeEach: installNativeFixtures,
  afterEach: assertNativeFixtures,
  decorators: [
    Story => (
      <div className="flex min-h-screen flex-col">
        <Story />
      </div>
    )
  ],
  args: {
    accounts: [],
    signInState: null,
    dispatcher: {
      recordWelcomeWizardInitiated: fn(),
      requestBrowserAuthenticationToDotcom: fn(),
      endWelcomeFlow: fn(),
      removeAccount: fn(async () => {}),
      setSignInEndpoint: fn(async () => {}),
      requestBrowserAuthentication: fn(),
      beginEnterpriseSignIn: fn(),
      beginDotComSignIn: fn(),
      resetSignInState: fn(),
      showPopup: fn(),
      closePopup: fn()
    }
  }
} satisfies Meta<typeof Welcome>
export default meta
type Story = StoryObj<typeof meta>
// Migrated layout and translated identity controls; native persistence remains in macOS E2E.
export const LayoutAndIdentity: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("heading", { name: i18n.t("welcome.title") })).toBeVisible()
    const welcome = canvasElement.querySelector<HTMLElement>("#welcome")!
    const content = canvasElement.querySelector<HTMLElement>(".welcome-content")!
    await waitFor(() => {
      const outer = welcome.getBoundingClientRect()
      const inner = content.getBoundingClientRect()
      expect(Math.abs(inner.left + inner.width / 2 - outer.left - outer.width / 2)).toBeLessThan(1)
      expect(
        inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom
      ).toBe(true)
    })
    await expect(getComputedStyle(welcome).backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
    await userEvent.click(canvas.getByRole("button", { name: i18n.t("welcome.skip") }))
    await expect(canvas.getByRole("heading", { name: i18n.t("welcome.configureGit") })).toBeVisible()
    await expect(canvas.getByRole("button", { name: i18n.t("welcome.finish") })).toBeVisible()
    await expect(canvas.getByPlaceholderText(i18n.t("welcome.namePlaceholder"))).toBeVisible()
  }
}
export const Start: Story = {}
