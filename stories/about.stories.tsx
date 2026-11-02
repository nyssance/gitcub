import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"

import { withNativeFixtures } from "../.storybook/mocks/native"
import { UpdateStatus } from "../src/lib/ui/update-store"
import { About } from "../src/ui/about/about"

const meta = {
  title: "Application/About",
  component: About,
  beforeEach: withNativeFixtures({
    "plugin:opener|open_url": () => {},
    desktop_dialog_did_open: () => {},
    desktop_dialog_did_close: () => {}
  }),
  args: {
    applicationName: "GitCub",
    applicationVersion: "0.1.0",
    applicationArchitecture: "aarch64",
    onDismissed: fn(),
    onCheckForNonStaggeredUpdates: fn(),
    onShowAcknowledgements: fn(),
    onShowTermsAndConditions: fn(),
    onQuitAndInstall: fn(),
    updateState: {
      status: UpdateStatus.UpdateNotChecked,
      lastSuccessfulCheck: null,
      isX64ToARM64ImmediateAutoUpdate: false,
      newReleases: null,
      prioritizeUpdate: false,
      prioritizeUpdateInfoUrl: undefined
    }
  }
} satisfies Meta<typeof About>
export default meta
type Story = StoryObj<typeof meta>
export const AuthorLink: Story = {}
