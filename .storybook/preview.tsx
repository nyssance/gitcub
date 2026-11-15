import "../src/lib/browser-runtime"
import "../src/lib/log"
import type { Preview } from "@storybook/react-vite"
import { I18nextProvider } from "react-i18next"
import { sb } from "storybook/test"

sb.mock(import("@tauri-apps/plugin-os"))

import i18n from "../src/lib/i18n"
import "../src/styles/globals.css"
import "./preview.css"

const preview: Preview = {
  globalTypes: {
    theme: { toolbar: { title: "Theme", icon: "paintbrush", items: ["light", "dark"], dynamicTitle: true } },
    locale: { toolbar: { title: "Language", icon: "globe", items: ["en", "zh-CN"], dynamicTitle: true } }
  },
  initialGlobals: { theme: "light", locale: "en" },
  parameters: { layout: "padded" },
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
        <div key={`${context.globals.theme}-${context.globals.locale}`}>
          <Story />
        </div>
      </I18nextProvider>
    )
  ]
}
export default preview
