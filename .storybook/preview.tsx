import "../src/lib/browser-runtime"
import "../src/lib/log"
import type { Preview } from "@storybook/react-vite"
import { I18nextProvider } from "react-i18next"
import { STORY_FINISHED } from "storybook/internal/core-events"
import { addons } from "storybook/preview-api"
import { sb } from "storybook/test"

sb.mock(import("@tauri-apps/plugin-os"))

import i18n from "../src/lib/i18n"
import "../src/styles/globals.css"
import "./preview.css"

// Expose the actual Storybook result, including play and accessibility failures, to browser acceptance.
addons
  .getChannel()
  .on(STORY_FINISHED, ({ storyId, status, reporters }: { storyId: string; status: string; reporters: unknown[] }) => {
    document.documentElement.dataset.storyFinished = storyId
    document.documentElement.dataset.storyStatus = status
    document.documentElement.dataset.storyReports = JSON.stringify(
      reporters.filter(
        report => typeof report === "object" && report !== null && "status" in report && report.status === "failed"
      )
    )
  })

const preview: Preview = {
  globalTypes: {
    theme: { toolbar: { title: "Theme", icon: "paintbrush", items: ["light", "dark"], dynamicTitle: true } },
    locale: { toolbar: { title: "Language", icon: "globe", items: ["en", "zh-CN"], dynamicTitle: true } }
  },
  initialGlobals: { theme: "light", locale: "en" },
  parameters: { layout: "padded", a11y: { test: "error" } },
  loaders: [
    async ({ globals }) => {
      document.documentElement.classList.toggle("dark", globals.theme === "dark")
      document.documentElement.lang = globals.locale
      document.body.classList.add("platform-darwin")
      await i18n.changeLanguage(globals.locale)
      return {}
    }
  ],
  decorators: [
    (Story, context) => (
      <I18nextProvider i18n={i18n}>
        <div key={`${context.globals.theme}-${context.globals.locale}`} data-gitcub-story={context.id}>
          <Story />
        </div>
      </I18nextProvider>
    )
  ]
}
export default preview
