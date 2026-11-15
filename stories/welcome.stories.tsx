import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { installNativeFixtures } from "../.storybook/mocks/native"
import { Welcome } from "../src/ui/welcome/welcome"

const meta = {
  title: "Onboarding/Welcome",
  component: Welcome,
  parameters: { layout: "fullscreen" },
  beforeEach: installNativeFixtures,
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
export const Default: Story = {}
export const Start: Story = {}
