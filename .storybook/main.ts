import type { StorybookConfig } from "@storybook/react-vite"

const config: StorybookConfig = {
  // Only application-owned stories. Generated shadcn components have no stories.
  stories: ["../stories/**/*.stories.tsx"],
  staticDirs: ["../public"],
  framework: { name: "@storybook/react-vite", options: {} },
  addons: ["@storybook/addon-a11y"],
  core: { disableTelemetry: true },
  typescript: { reactDocgen: false },
  async viteFinal(config) {
    const { mergeConfig } = await import("vite")
    return mergeConfig(config, {
      server: { strictPort: false },
      build: { sourcemap: false }
    })
  }
}
export default config
