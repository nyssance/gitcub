import { fileURLToPath } from "node:url"

import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: [
    "storybook.spec.ts",
    "desktop-layout.spec.ts",
    "ci-layout.spec.ts",
    "discovery-layout.spec.ts",
    "history-layout.spec.ts"
  ],
  fullyParallel: true,
  workers: 4,
  retries: 0,
  outputDir: "../test-results/storybook",
  reporter: [["list"], ["html", { outputFolder: "test-results/storybook-report", open: "never" }]],
  use: { baseURL: "http://127.0.0.1:6007", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    command: "bunx --bun --no-install vite preview --outDir storybook-static --host 127.0.0.1 --port 6007 --strictPort",
    url: "http://127.0.0.1:6007/index.json",
    reuseExistingServer: false
  }
})
